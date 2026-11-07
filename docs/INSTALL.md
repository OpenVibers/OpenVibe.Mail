# Installing M1 on the host

M1 is receive-only. Do not install it on the production host until Opus has reviewed the PRs. These are the steps
Opus runs; nothing in this repository deploys itself.

The order matters: PostgreSQL and the blob store first, then Stalwart in recovery mode so its default listeners do
not collide with the plan, then the plan's listeners, then the Node service.

## 0. What is needed

- The host's public IPv4 (and IPv6 if it has one), with inbound TCP 25 allowed and **587/465 closed**.
- PostgreSQL 18 reachable on the host (direct for migrations; PgBouncer for the runtime if the host uses it).
- A Backblaze B2 bucket `openvibe-mail` and an application key limited to that bucket (read/write).
- Node 22 on the host.
- The pinned Stalwart binary, see [`deploy/stalwart/VERSION`](../deploy/stalwart/VERSION).

Create the service user once:

```sh
sudo useradd --system --home /var/lib/openvibe-stalwart --shell /usr/sbin/nologin openvibe
sudo install -d -m 0750 -o root -g openvibe /etc/openvibe
sudo install -d -m 0755 -o root -g root /opt/openvibe.stalwart /opt/openvibe.mail
```

## 1. Database

The house way is `OpenVibe.Host roles/data/add-service.sh`; if that is not used, the equivalent is:

```sh
sudo -u postgres psql <<'SQL'
CREATE ROLE ov_mail LOGIN PASSWORD 'REPLACE_WITH_A_LONG_PASSWORD';
CREATE DATABASE ov_mail OWNER ov_mail;
SQL
```

`ov_mail` is both the service's database and Stalwart's data store. Stalwart creates its own tables in `public`;
the service's migrations create `mail_*` and the directory view. They share the database on purpose.

### The directory shape (M1)

`mail_directory_accounts` is the only thing Stalwart reads to decide who an address is:

- **Every burner is its own account.** The row's `name` is the burner address itself, anonymous or owned. One
  burner's mail can never appear in another burner's mailbox, and the service reads that account with no recipient
  filtering at all. The purge job deletes the messages, destroys the account and removes the row together.
- **Masks and agent inboxes are aliases of the person's mailbox.** Their row's `name` is the owner's mailbox
  address and the address is listed by `queryEmailAliases`. The service matches each message against the **first**
  `Delivered-To` header — the one Stalwart stamps at delivery — never against a sender-written To, Cc or
  Delivered-To.
- There is **no pool mailbox**; a burner's account is the isolation boundary. `mail_settings` holds the purge
  lease and the row that serializes the anonymous-burner cap.
- A disabled mask, an expired burner and a burner that took its one message resolve to no row, so the mail server
  refuses the address.

## 2. Blob store

Create the bucket and an application key in B2. Note the endpoint (for example
`https://s3.eu-central-003.backblazeb2.com`) and the region (`eu-central-003`). Stalwart stores message blobs
there; the service never reads blobs directly.

## 3. The Stalwart binary

On the host, from a checkout of this repository:

```sh
node scripts/fetch-stalwart.js
sha256sum .cache/stalwart/stalwart-x86_64-unknown-linux-gnu.tar.gz  # must equal deploy/stalwart/VERSION
sudo install -m 0755 .cache/stalwart/stalwart /opt/openvibe.stalwart/stalwart
/opt/openvibe.stalwart/stalwart --version   # 1.0.3
```

Do not substitute a newer release without reviewing `UPGRADING/` and re-running the acceptance test: the
configuration is written against the pinned JMAP object schema.

## 4. Environment files

`/etc/openvibe/stalwart.env` (root:root, 0600):

```sh
STALWART_DB_HOST=127.0.0.1
STALWART_DB_PORT=5432
STALWART_DB_NAME=ov_mail
STALWART_DB_USER=ov_mail
STALWART_DB_PASSWORD=REPLACE
STALWART_BLOB_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
STALWART_BLOB_BUCKET=openvibe-mail
STALWART_BLOB_REGION=eu-central-003
STALWART_BLOB_ACCESS_KEY_ID=REPLACE
STALWART_BLOB_SECRET_KEY=REPLACE
```

`/etc/openvibe/mail.env` (root:root, 0600) — names are described in `.env.example`; the values that matter for M1:

```sh
NODE_ENV=production
PORT=5250
HOST=127.0.0.1
BASE_URL=https://openvibe.email
TRUST_PROXY=2
DATABASE_URL=postgres://ov_mail:REPLACE@127.0.0.1:5432/ov_mail
DATABASE_DIRECT_URL=postgres://ov_mail:REPLACE@127.0.0.1:5432/ov_mail
OV_NETWORK_URL=https://openvibe.network
OV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000
MAIL_BASE_DOMAIN=openvibe.email
MAIL_MASK_DOMAIN=mask.openvibe.email
BURNER_DOMAINS=burn1.openvibe.email,burn2.openvibe.email,burn3.openvibe.email
MAIL_MAX_LIVE_ANON_BURNERS=2000
STALWART_URL=http://127.0.0.1:8080
STALWART_ADMIN_USER=admin
STALWART_ADMIN_PASSWORD=REPLACE_WITH_THE_RECOVERY_ADMIN_PASSWORD
MAIL_EVENTS_URL=http://127.0.0.1:4300
MAIL_EVENTS_CLIENT_ID=mail
MAIL_EVENTS_CLIENT_SECRET=REPLACE
```

If the host uses PgBouncer, `DATABASE_URL` points at it and `DATABASE_DIRECT_URL` stays direct; migrations run on
the direct connection. The Stalwart env file needs the blob keys only for `apply.js`; the running server reads the
blob store from its database.

## 5. Render the configuration

```sh
sudo sh -c 'set -a; . /etc/openvibe/stalwart.env; set +a; \
  STALWART_RENDER_DIR=/etc/openvibe/stalwart node deploy/stalwart/render.js'
sudo chown root:openvibe /etc/openvibe/stalwart/config.json /etc/openvibe/stalwart/plan.json
sudo chmod 0640 /etc/openvibe/stalwart/config.json
sudo chmod 0600 /etc/openvibe/stalwart/plan.json
```

`config.json` is the small data-store file Stalwart v1.0.3 reads; its password is an environment variable
reference, not a value. `plan.json` is the JMAP reconciliation plan and contains no secret.

## 6. First start in recovery mode, then apply

Recovery mode binds one HTTP port and none of the default mail listeners, so the plan can remove the submission,
POP3, Sieve and HTTPS listeners before they ever open.

Use the same password after `admin:` here and as `STALWART_ADMIN_PASSWORD` in `mail.env`: the Node service reads mail with it.

Create a one-time recovery env file (root:openvibe, 0640) so the admin password is never on a command line:

```sh
sudo sh -c 'umask 027; cat > /etc/openvibe/stalwart-recovery.env <<EOF
STALWART_DB_PASSWORD=$(. /etc/openvibe/stalwart.env; printf %s "$STALWART_DB_PASSWORD")
STALWART_RECOVERY_ADMIN=admin:REPLACE_WITH_A_LONG_ADMIN_PASSWORD
STALWART_RECOVERY_MODE=1
STALWART_RECOVERY_MODE_PORT=18080
EOF'
sudo chown root:openvibe /etc/openvibe/stalwart-recovery.env
sudo chmod 0640 /etc/openvibe/stalwart-recovery.env
sudo -u openvibe sh -c 'set -a; . /etc/openvibe/stalwart-recovery.env; set +a; \
  exec /opt/openvibe.stalwart/stalwart --config /etc/openvibe/stalwart/config.json' &
echo $! > /tmp/stalwart-recovery.pid
```

Wait until `ss -ltn | grep 18080` shows the recovery listener, then apply:

```sh
sudo sh -c 'set -a; . /etc/openvibe/stalwart.env; . /etc/openvibe/mail.env; set +a; \
  STALWART_URL=http://127.0.0.1:18080 node deploy/stalwart/apply.js --plan /etc/openvibe/stalwart/plan.json'
kill "$(cat /tmp/stalwart-recovery.pid)"
rm -f /etc/openvibe/stalwart-recovery.env
```

The first pass creates the SQL directory, the domains, the S3 blob store, the spam setting and the three listeners.
It may skip the default roles because recovery mode has not written them yet; the second pass below sets them.

## 7. Start the service and apply the roles

Install the units:

```sh
sudo install -m 0644 deploy/systemd/openvibe-stalwart.slice /etc/systemd/system/
sudo install -m 0644 deploy/systemd/openvibe-stalwart.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/openvibe-mail.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openvibe-stalwart.slice openvibe-stalwart.service
```

Now the normal start has written the built-in roles. Apply again; this sets `Authentication.defaultUserRoleIds`
(the `User` role) and reloads the settings, so an account the directory creates receives mail instead of being
refused with "This account is not authorized to receive email":

```sh
sudo sh -c 'set -a; . /etc/openvibe/stalwart.env; . /etc/openvibe/mail.env; set +a; \
  STALWART_URL=http://127.0.0.1:8080 node deploy/stalwart/apply.js --plan /etc/openvibe/stalwart/plan.json'
```

Check what is listening:

```sh
sudo ss -ltnp | grep -E ':(25|143|8080|5250)\b'
```

Expected: `0.0.0.0:25` (or the host's public address), `127.0.0.1:8080`, `127.0.0.1:143`. There must be **no**
`587`, `465`, `993`, `995`, `4190` or `:443` listener from Stalwart.

## 8. The Node service

```sh
sudo rsync -a --delete --exclude node_modules --exclude .git --exclude .cache ./ /opt/openvibe.mail/
cd /opt/openvibe.mail
sudo npm ci --omit=dev --no-audit --no-fund
sudo sh -c 'set -a; . /etc/openvibe/mail.env; set +a; node deploy/init-db.js'
sudo systemctl enable --now openvibe-mail.service
```

`deploy/init-db.js` runs the migrations through `DATABASE_DIRECT_URL`; the service would also do it at boot, but a
failure here is easier to read. The service adds the domains it knows on start; there is no pool mailbox.

## 9. DNS

Publish the records in [`docs/DNS.md`](DNS.md), keeping the mail A/AAAA records **DNS-only** in Cloudflare. Wait for
the MX, then test from outside:

```sh
dig +short MX openvibe.email
python3 -c "import smtplib; s=smtplib.SMTP('mail.openvibe.email',25,timeout=10); print(s.ehlo()[1]); s.quit()"
```

## 10. Verify

```sh
curl -fsS http://127.0.0.1:5250/api/health
curl -fsS http://127.0.0.1:5250/api/ready
systemctl status openvibe-stalwart.service openvibe-mail.service --no-pager
journalctl -u openvibe-stalwart -u openvibe-mail --since '10 min ago' --no-pager | tail -40
```

Then, with a person's token, create a mask, send it one message from another account, and read it through JMAP (or
create a burner and use `GET /api/v1/burners/:id/code`). A body must never appear in either journal.

## 11. Firewall and things not to do

- Allow inbound TCP 25 only. Do not open 587 or 465: there is no submission listener and no relay.
- Keep 8080, 143 and 5250 on loopback. The public API is whatever nginx/Network fronts; M1 has no public site.
- Do not add a second MX or an outbound SMTP path. Sending is M3.
- Do not run Stalwart as root; the unit keeps only `CAP_NET_BIND_SERVICE` for port 25.
- The memory cap is the slice's (`/etc/systemd/system/openvibe-stalwart.slice`). The host OOMed on 2026-11-07; do
  not raise `MemoryMax` without measuring the spam filter and a busy mailbox first.

## 12. Rollback

```sh
sudo systemctl stop openvibe-mail.service openvibe-stalwart.service
sudo systemctl disable openvibe-mail.service openvibe-stalwart.service
```

The data stays in PostgreSQL (`ov_mail`) and B2. Removing the DNS MX records stops new mail; mail already queued on
other servers retries until their expiry, so keep the host reachable until the queues drain.
