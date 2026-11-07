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
| **Directory** | Stalwart's SQL directory reads `mail_directory_accounts`: the mailbox itself, every active mask, every unexpired burner and every agent inbox resolves to its owner's mailbox; a disabled mask or an expired burner resolves to no row and the mail bounces. |

The service stores only the addresses and metadata: message bodies are read from Stalwart over loopback JMAP when a
code is asked for, and are never written to a log, an event or the database.

## API

All routes are under `/api/v1` and take an OpenVibe.Network token (`Authorization: Bearer …`). An app token must
name the person it acts for (`on_behalf_of`) and carry `mail.addresses.write` or `mail.messages.read`. A typed token
(a `typ` or `purpose` claim) is refused.

| Method | Route | Who |
|---|---|---|
| `POST` | `/masks` | a person; `{ label, purpose }` |
| `GET` | `/masks` | a person |
| `GET` | `/masks/:id` | the owner; anyone else gets 404 |
| `DELETE` | `/masks/:id` | the owner; turns the mask off |
| `POST` | `/burners` | a person, or nobody (`{ expires: "10m" \| "1h" \| "1d" \| "7d", first_message_only }`) |
| `GET` | `/burners` | a person |
| `GET` | `/burners/:id/messages` | the owner, or the holder of the returned `x-mail-burner-token` |
| `GET` | `/burners/:id/code` | the same; the newest verification code, extracted from text or HTML |
| `POST` | `/agent-inboxes` | a person; `{ agent_id }` |
| `GET` | `/agent-inboxes` | a person |
| `GET` | `/agent-inboxes/:id/messages` | the owner |

Somebody else's mask, burner or inbox answers **404**, never 403: the answer must not say it exists. A message
summary is `{ id, from, subject, received_at }` — no preview, no body. `GET /api/ready` asks the database and
Stalwart; `/api/health` is the liveness answer.

## Events

The outbox (`event_outbox`) publishes, through OpenVibe.Events when configured:

- `mail.mask.created` — the mask exists;
- `mail.received` — metadata only: the address, the sender, the message id and the time. **No subject, no body,
  no code.**

## Contracts

`mail.mask@1`, `mail.burner@1`, `mail.agent-inbox@1` and `mail.message-summary@1` are proposed as an expand-only
minor of [OpenVibe.Contracts](https://github.com/OpenVibers/OpenVibe.Contracts). The service pins
`openvibe-contracts` v0.327.0 until that minor is released.

## Stalwart

Stalwart Community is pinned in [`deploy/stalwart/VERSION`](deploy/stalwart/VERSION) (1.0.3, sha256 verified by
`scripts/fetch-stalwart.js`). Stalwart v0.16 and later stopped reading TOML, so
[`deploy/stalwart/config.toml`](deploy/stalwart/config.toml) is **our** declarative source of truth:

```sh
node deploy/stalwart/render.js   # → rendered/config.json (the data store) + rendered/plan.json
node deploy/stalwart/apply.js    # reconciles the plan over loopback JMAP
```

The plan creates the SQL directory and its queries, the base/mask/burner domains (all `allowRelaying = false`), the
S3 blob store, the built-in spam filter, and exactly three listeners: SMTP on 25, JMAP/management and IMAP on
loopback. Every default submission/HTTPS/POP3/Sieve listener is removed. The authentication defaults give a
directory-created account the `User` role — without it Stalwart creates the account and then refuses its own mail.

## Tests

```sh
npm test               # unit: PGlite, an in-process Network and an in-memory mail server
npm run test:pg        # the same through the PostgreSQL container
npm run test:stalwart  # the acceptance run: real Stalwart + PostgreSQL + MinIO
```

The acceptance run (also `test/stalwart/integration.test.js` in CI) starts the pinned binary in recovery mode so
its default listeners do not collide with the test ports, applies the plan, restarts it on the plan's listeners, and
checks:

- SMTP to a burner lands, `/code` returns the code, and no body or code reaches the service log;
- a first-message-only burner refuses the second message;
- an expired burner's mail is deleted and the address bounces;
- mail to a disabled mask bounces;
- another person gets 404 for a mask, burner and agent inbox;
- a ten-minute burner works without an account and is read with its token.

## Layout

```
server/            the API, domains, Stalwart client, events and the due-based purge job
migrations/        NNNN_*.sql (expand-only), including the directory view Stalwart reads
deploy/stalwart/   config.toml, VERSION, render.js, apply.js
deploy/systemd/    the memory-capped Stalwart slice and both units
deploy/init-db.js  apply migrations before systemd starts the service
test/              unit tests and the real-Stalwart acceptance test
docs/              INSTALL.md and DNS.md
```

## Limits

A person has 20 masks and 5 live burners. A 10-minute (account-less) burner is capped at 10 per IP per hour. The
counters live in PostgreSQL, so a restart does not hand out a fresh allowance.

## Install

See [`docs/INSTALL.md`](docs/INSTALL.md) and [`docs/DNS.md`](docs/DNS.md). M1 is **not deployed** from this
repository; Opus installs it on the host.

## Licence

AGPL-3.0-only, matching Stalwart Community. OpenVibe.Mail ships configuration and a Node service, not a modified
Stalwart.
