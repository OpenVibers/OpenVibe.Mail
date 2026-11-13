# OpenVibe.Mail

`openvibe.email` — masks that protect you, burners that self-destruct, and an inbox for every agent.

**Live site:** https://openvibe.email · **API docs:** https://openvibe.services · **For AI:** https://openvibe.email/llms.txt
**Run it:** `npm ci && npm start` (Node 22 or newer) · **Tests:** `npm test`

Mail receives mail for OpenVibe mailboxes and includes opt-in Inbox AI, which can also pull another provider's
mailbox over IMAP (TLS only, read only, app password sealed with `MAIL_SECRETS_KEY`). Replies stay drafts until the
person edits and clicks Send; external delivery remains closed unless the configured outbound relay is enabled. See
[Inbox AI](docs/INBOX-AI.md) for the consent, rules, journal, undo and receipts APIs.

## Person mail

`/inbox` also lets a person create a named address or alias, compose plain-text mail, attach a custom domain, and
forward a copy to another email they verified on their Network account. Sending requires a verified account email,
a one-day-old account, a verified sender domain, and a live Network trust check. The allowance starts at 20
recipients per day and rises to 50 or 100 with account age and successful history. Each message has at most 10
recipients. Hard bounces and complaints tied to provider message IDs pause the sender; a report link is in the
message and its `X-OpenVibe-Report-Abuse` header for SMTP delivery. No bulk list mode is offered.

Forwarding checks Network ownership when a rule is created and again before each copy. A revoked address disables
its rule. Only non-junk plain-text messages without attachments are copied; an ambiguous provider response is not
retried automatically. Network service credentials and the `identity.trust.read` and `identity.emails.read` grants
must be present. `MAIL_OUTBOUND=on` and an enabled provider remain required for external sending and forwarding.
See [custom-domain DNS](docs/DNS.md) for the inbound path and verification states.

## M1.5: read your mail (2026-11-07)

`/inbox` on openvibe.email shows a signed-in person's mailbox and the addresses that deliver into it (masks, agent
inboxes), for its owner only (another person's message is the same 404 as a missing one):

| Route | What |
|---|---|
| `GET /api/v1/me/mail/addresses` | the mailbox and the addresses that deliver into it |
| `GET /api/v1/me/mail/messages?address=&cursor=` | a page, newest first; an address is matched on the server's `Delivered-To` stamp only |
| `GET /api/v1/me/mail/messages/:id[?images=1]` | one message: text, and HTML cleaned on the server |
| `GET /api/v1/me/mail/messages/:id/attachments/:part` | a download (`attachment`, `nosniff`, an allow-listed type or `application/octet-stream`) |
| `POST …/:id/read`, `…/:id/unread`, `DELETE …/:id` | seen flags; Delete moves it to the Trash |

**Two layers for a sender's HTML.** `server/domain/reading.js` cleans it with
[sanitize-html](https://github.com/apostrophecms/sanitize-html) (MIT): an allow-list of tags and attributes, `style`
limited to layout and colour properties whose values can hold no `url()`, `expression()` or `@import`, links only
http(s)/mailto opening in a new tab with `rel="noopener noreferrer"`. Remote images, the way senders track opening,
are replaced by their alt text and counted (`blocked_images`) until the person asks (`?images=1`, https only). The
page (`public/js/inbox.js`) then shows the result in an iframe with no `allow-scripts` and its own CSP
(`default-src 'none'`). Bodies go to their owner and nowhere else: never a log line, an event or a row
(`test/reading.test.js` and the Stalwart acceptance test check the logger).

## What is in M1

| Piece | What it does |
|---|---|
| **Masks** | `amazon.k7fq@mask.openvibe.email` — a per-site address that delivers into your OpenVibe mailbox and nowhere else. Turn it off and it bounces. |
| **Burners** | `q7fq2k9d@burn2.openvibe.email` — receive-only, expires after 10 minutes, 1 hour, 1 day or 7 days, or after the first message. A 10-minute burner needs no account. Its mail is deleted when it expires. |
| **Agent inboxes** | `helper.alice@openvibe.email` — an address an agent can read, on the person's own domain. |
| **Directory** | Stalwart's SQL directory reads `mail_directory_accounts`: every unexpired burner is its **own** account (the burner address is the primary address), so one burner's mail can never be read in another's. Masks and agent inboxes are aliases of the owner's mailbox. A disabled mask or an expired burner resolves to no row and the mail bounces. |
| **Blobs** | Message blobs live on the mail server's local disk by default (`/var/lib/openvibe-stalwart/blobs`, `STALWART_BLOB_STORE=fs`). S3-compatible storage (B2 in production, MinIO in CI) stays available with `STALWART_BLOB_STORE=s3`. |

Raw message bodies are read from Stalwart over loopback JMAP and are never written to logs or events. With Inbox AI
enabled, summaries and editable reply drafts are stored per thread in Mail; the draft is the only generated body
persisted. A burner's account is read with no
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
| `GET` | `/agent-inboxes/:id/answering` | the owner; the switch, off by default (`mail.inbox-answering@1`) |
| `PUT` | `/agent-inboxes/:id/answering` | the owner; `{ enabled }` turns an agent's answering on or off |
| `GET` | `/me/mail/blocks` | the person's blocked senders |
| `POST` | `/me/mail/blocks` | the person; `{ address }` |
| `DELETE` | `/me/mail/blocks/:address` | the person's own block |

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
- `mail.agent_inbox.received` — an agent's address whose answering the person turned ON. The inbox and the agent,
  the owner, the message id, the sender, the subject, and a plain-text excerpt of **at most 4000 characters**.
  Never the HTML, never an attachment, and nothing at all for a message the mail server marked as spam or a sender
  on the person's block list.

## An agent answers the mail sent to its own address (HO6)

An agent's inbox is an address, not an invitation: answering is a **switch, off by default**, that the person turns
on for one agent. While it is on, the due poll (`server/jobs/agent-mail.js`) reads the newest messages of the
person's mailbox as that inbox, and for each letter not seen before publishes `mail.agent_inbox.received` once —
the row that says the letter is the agent's and the event commit in one transaction, so an overlapping poll or a
restart never announces it twice. Spam, a blocked sender and the inbox's own address start nothing.

The agent's system then acts on the event. It reads the whole letter in plain text through `mail.agent.read`
(loopback, first-party service token, the person named in `X-OV-Subject`), and answers through `mail.agent.reply`:
the reply is sent **from the agent's address**, to the sender of the letter and to nobody else, plain text, with
`In-Reply-To`/`References` read from the letter itself. Every send is recorded in `mail_sent_mail` with its outcome.

**Outbound is not ours yet.** A reply goes only to one of the owner's own `openvibe.email` addresses — their
mailbox, a mask, a burner — which is local delivery on our own server, no packet off the host. Sending to anyone
else is plan M2 and waits on the owner (a separate mail IPv4, its PTR record, Workers Paid for the relay), so it is
behind a switch that is **off by default**: `MAIL_OUTBOUND=on` is the only way on. With it off, `routeFor` answers
before any connection is opened, `POST …/reply` answers `409 mail.outbound_closed` with the plain sentence "OpenVibe
Mail cannot send outside OpenVibe yet: the reply waits here", and the agent's system turns that into the person's
send approval: the reply stays pending, nothing is sent and nothing is lost. `GET /internal/mail/outbound` says
whether the switch is on, so the approval card can say so itself.

## Contracts

`mail.mask@1`, `mail.burner@1`, `mail.agent-inbox@1`, `mail.message-summary@1`, `mail.agent-inbox-message@1`,
`mail.agent-reply-request@1`, `mail.agent-reply-result@1`, `mail.inbox-answering@1` and
`mail.agent_inbox.received@1` are in
[OpenVibe.Contracts](https://github.com/OpenVibers/OpenVibe.Contracts) v0.342.0, which this service pins. The
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

<!-- versions:start -->
- openvibe-contracts: v0.419.0
- openvibe-sdk: v0.161.0
- openvibe-shared: v4.232.0
<!-- versions:end -->
