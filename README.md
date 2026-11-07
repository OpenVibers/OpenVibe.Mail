# OpenVibe.Mail

`openvibe.email` — masks that protect you, burners that self-destruct, and an inbox for every agent.

M1 is **receive only**: Stalwart Community listens on port 25, the service hands out addresses that resolve into
OpenVibe mailboxes, and nothing here sends or relays mail. Sending, inbox AI and paid custom domains are M2–M4 in
the OpenVibe Seven Domains plan (2026-11-07) §8.

## What is in M1

| Piece | What it does |
|---|---|
| **Masks** | `amazon.k7fq@mask.openvibe.email` — a per-site address that delivers into your OpenVibe mailbox and nowhere else. Turn it off and it bounces. |
| **Burners** | `q7fq2k9d@burn2.openvibe.email` — receive-only, expires after 10 minutes, 1 hour, 1 day or 7 days, or after the first message. A 10-minute burner needs no account. Its mail is deleted when it expires. |
| **Agent inboxes** | `helper.alice@openvibe.email` — an address an agent can read, on the person's own domain. |
| **Directory** | Stalwart's SQL directory reads `mail_directory_accounts`: every unexpired burner is its **own** account (the burner address is the primary address), so one burner's mail can never be read in another's. Masks and agent inboxes are aliases of the owner's mailbox. A disabled mask or an expired burner resolves to no row and the mail bounces. |
| **Blobs** | Message blobs live on the mail server's local disk by default (`/var/lib/openvibe-stalwart/blobs`, `STALWART_BLOB_STORE=fs`). S3-compatible storage (B2 in production, MinIO in CI) stays available with `STALWART_BLOB_STORE=s3`. |

The service stores only the addresses and metadata: message bodies are read from Stalwart over loopback JMAP when a
code is asked for, and are never written to a log, an event or the database. A burner's account is read with no
recipient filtering at all; a mask/agent inbox in the shared person mailbox is matched only against the first
`Delivered-To` header, the one Stalwart stamps — never a sender-written To, Cc or Delivered-To.

## API

All routes are under `/api/v1` and take an OpenVibe.Network token (`Authorization: Bearer …`), or the person's
same-site session cookie on openvibe.email (set by `openvibe-sdk/sso` after sign-in; `/auth/*` is the sign-in
handshake). A cross-origin browser may send a Bearer token from any first-party origin in the Contracts manifests
(CORS); a cookie-authenticated **write** must come from openvibe.email itself (`Sec-Fetch-Site`/`Origin`). An app
token must name the person it acts for (`on_behalf_of`) and carry `mail.addresses.write` or
`mail.messages.read`. A typed token (a `typ` or `purpose` claim) is refused.

| Method | Route | Who |
|---|---|---|
| `GET` | `/me/mail` | a person; masks, burners and agent inboxes with state, expiry and counts (see below) |
| `POST` | `/masks` | a person; `{ purpose, expires_days?, label? }` |
| `GET` | `/masks` | a person |
| `GET` | `/masks/:id` | the owner; anyone else gets 404 |
| `POST` | `/masks/:id/disable` | the owner; turns the mask off |
| `DELETE` | `/masks/:id` | the same, for a DELETE-shaped client |
| `POST` | `/burners` | a person, or nobody (`{ expires: "10m" \| "1h" \| "1d" \| "7d", first_message_only }`) |
| `GET` | `/burners` | a person |
| `GET` | `/burners/:id/messages` | the owner, or the holder of the returned `x-mail-burner-token` |
| `GET` | `/burners/:id/code` | the same; the newest verification code, extracted from text or HTML |
| `POST` | `/agent-inboxes` | a person; `{ agent_id }` |
| `GET` | `/agent-inboxes` | a person |
| `GET` | `/agent-inboxes/:id/messages` | the owner |

Somebody else's mask, burner or inbox answers **404**, never 403: the answer must not say it exists. The messages
API returns an array of `{ id, from, subject, received_at }` and nothing else: no preview, no body, no HTML. The
`/code` endpoint returns `{ code, message_id, received_at, from }`; it extracts the code from text or HTML in
memory and never returns the body. `GET /api/ready` asks the database and Stalwart; `/api/health` is the liveness
answer.

`GET /api/v1/me/mail` is the one call the page makes: it returns `masks`, `burners` and `agent_inboxes`, where each
item carries the Contracts resource (`mask`, `burner`, `agent_inbox`) exactly, beside the listing fields `address`,
`purpose`, `state`, a mask's `expires_at`, and `counts.messages` (the messages the service has already seen for that
address), plus totals under `counts`. No subject, sender, body or code is in it. A mask made with `expires_days` turns itself off when the date
arrives; the purge job disables the due rows and the directory stops resolving them.

## Events

The outbox (`event_outbox`) publishes, through OpenVibe.Events when configured:

- `mail.mask.created` — the mask exists;
- `mail.received` — metadata only: the address, the sender, the message id and the time. **No subject, no body,
  no code.**

## Contracts

`mail.mask@1`, `mail.burner@1`, `mail.agent-inbox@1` and `mail.message-summary@1` are in
[OpenVibe.Contracts](https://github.com/OpenVibers/OpenVibe.Contracts) v0.329.0, which this service pins. The
`/me/mail` listing is a projection above them (state, expiry, counts) — the Contracts resources do not grow extra
fields, and no Contracts release is made from this repository.

## Stalwart

Stalwart Community is pinned in [`deploy/stalwart/VERSION`](deploy/stalwart/VERSION) (1.0.3, sha256 verified by
`scripts/fetch-stalwart.js`). Stalwart v0.16 and later stopped reading TOML, so
[`deploy/stalwart/config.toml`](deploy/stalwart/config.toml) is **our** declarative source of truth:

```sh
node deploy/stalwart/render.js   # → rendered/config.json (the data store) + rendered/plan.json
node deploy/stalwart/apply.js    # reconciles the plan over loopback JMAP
```

The plan creates the SQL directory and its queries, the base/mask/burner domains (all `allowRelaying = false`), the
filesystem blob store (or S3 when `STALWART_BLOB_STORE=s3`), the built-in spam filter, and exactly three listeners:
SMTP on 25, JMAP/management and IMAP on loopback. Every default submission/HTTPS/POP3/Sieve listener is removed. The authentication defaults give a
directory-created account the `User` role — without it Stalwart creates the account and then refuses its own mail.

## Tests

```sh
npm test               # unit: PGlite, an in-process Network and an in-memory mail server
npm run test:pg        # the same through the PostgreSQL container
npm run test:stalwart  # the acceptance run: real Stalwart + PostgreSQL, fs blobs by default (MinIO with
                       # STALWART_BLOB_STORE=s3)
```

The acceptance run (also `test/stalwart/integration.test.js` in CI) starts the pinned binary in recovery mode so
its default listeners do not collide with the test ports, applies the plan, restarts it on the plan's listeners, and
checks:

- SMTP to a burner lands, `/code` returns the code, and no body or code reaches the service log;
- a message to burner A with forged To, Cc and Delivered-To naming burner B never appears in B's messages or
  `/code`;
- 300 messages to burner A do not hide burner B's one message (each burner is its own account);
- a forged Delivered-To does not move mail between two agent inboxes on one person's mailbox;
- a first-message-only burner refuses the second message;
- an expired burner's mail is deleted, its account is removed and the address bounces;
- mail to a disabled mask bounces;
- another person gets 404 for a mask, burner and agent inbox;
- a ten-minute burner works without an account and is read with its token;
- the message blob is on the local disk with `STALWART_BLOB_STORE=fs` (and the same run passes with `s3` in CI);
- the CORS allow-list, the same-site cookie write rule and the `/me/mail` listing.

## Layout

```
server/            the API, domains, Stalwart client, events and the due-based purge job
migrations/        NNNN_*.sql (expand-only), including the directory view Stalwart reads
deploy/stalwart/   config.toml, VERSION, render.js, apply.js
deploy/systemd/    the memory-capped Stalwart slice and both units
deploy/nginx/      openvibe.email.conf — the public door (API, health, ready, /auth)
deploy/init-db.js  apply migrations before systemd starts the service
test/              unit tests and the real-Stalwart acceptance test
docs/              INSTALL.md and DNS.md
```

## Limits

A person has 20 masks and 5 live burners. A 10-minute (account-less) burner is capped at 10 per IP per hour and at
2,000 live anonymous burners globally; past the global cap the API answers 503 `mail.burner_capacity`. The counters
live in PostgreSQL, so a restart does not hand out a fresh allowance.

## Install

See [`docs/INSTALL.md`](docs/INSTALL.md) and [`docs/DNS.md`](docs/DNS.md). M1 is **not deployed** from this
repository; Opus installs it on the host.

## Licence

AGPL-3.0-only, matching Stalwart Community. OpenVibe.Mail ships configuration and a Node service, not a modified
Stalwart.
