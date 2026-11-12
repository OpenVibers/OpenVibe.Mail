# AGENTS.md — OpenVibe.Mail

## Project Overview

OpenVibe.Mail is `openvibe.email`: masks that protect you, burners that self-destruct, an inbox for every agent, and
person mail (read your mailbox, compose, custom domains, forwarding, read-only IMAP of another provider, opt-in Inbox
AI). M1 is **receive-only**: Stalwart Community listens on port 25; the service hands out addresses that resolve into
mailboxes, and nothing sends or relays outside OpenVibe unless `MAIL_OUTBOUND=on` and an outbound provider are both
configured (external sending is M2 and off by default).

- **Domain:** `openvibe.email` · **Port:** 5250 (API; SMTP 25, JMAP/IMAP loopback) · **Service id:** `mail` ·
  **Env prefix:** `MAIL`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Stalwart
  Community 1.0.3 pinned in [deploy/stalwart/VERSION](deploy/stalwart/VERSION), `imapflow`/`mailparser`/`nodemailer`
  for the optional person-mail paths.
- **Read first:** [README.md](README.md), [docs/INBOX-AI.md](docs/INBOX-AI.md), [docs/INSTALL.md](docs/INSTALL.md),
  [docs/DNS.md](docs/DNS.md), [docs/INBOX.md](docs/INBOX.md).

**Network context:** identity, tokens, staff roles, verified emails and the trust check are OpenVibe.Network
(`identity.trust.read`, `identity.emails.read`). Account export/deletion is ADR-033 through OpenVibe.Events. Mail AI
(`server/ai/inbox.js`) is optional. The mail server is Stalwart's own process; this repository ships its declarative
config and a Node API, not a modified Stalwart. Message bodies are read from Stalwart over loopback JMAP and are never
written to logs, events or the database (the one exception is Inbox AI's opt-in summary/editable draft, and the draft
is the only generated body persisted).

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm start                      # node server/index.js (API; Stalwart runs separately)
npm test                       # unit: PGlite, in-process Network and in-memory mail server
npm run test:pg                # the same through PostgreSQL
npm run test:stalwart          # acceptance: real Stalwart + PostgreSQL (MinIO with STALWART_BLOB_STORE=s3)
npm run init-db                # node deploy/init-db.js (apply migrations before systemd starts the service)
npm run stalwart:fetch         # verify/download the pinned Stalwart (sha256)
npm run stalwart:render        # config.toml → rendered/config.json + rendered/plan.json
npm run stalwart:apply         # reconcile the plan over loopback JMAP
node --check <file.js>         # syntax check (no linter configured)
```

No build step: the page and assets are served from [public/](public/) (`css/inbox.css`, `css/mail.css`, `js/inbox.js`,
`js/compose.js`, `js/mail.js`, `js/mail-providers.js`).

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — database/migrations, mail server client, events relay, purge,
  agent-mail, Inbox AI, IMAP pull and forwarding jobs, then the listener; each job is due-based and stops on SIGTERM.
- **App factory:** [server/app.js](server/app.js) — helmet/CSP, `/auth`, CORS, `/api/v1`, `/internal/`, machine
  endpoints, the page/static mount [server/http/pages.js](server/http/pages.js), error handler.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/mail.env`.
- **Domains:** [server/domain/](server/domain/) — `masks.js`, `burners.js`, `agent-inboxes.js`, `agent-answering.js`,
  `agent-reply.js`, `addresses.js`, `messages.js`, `mailboxes.js`, `reading.js` (HTML cleaning), `sending.js`,
  `compose.js`, `custom-domains.js`, `forwarding.js`, `person-mail.js`, `mail-search.js`, `inbox-ai*.js`,
  `imap-connections.js`, `imap-secrets.js`, `outbound-providers.js`, `provider-*.js`, `limits.js`,
  `network-policy.js`.
- **Mail server:** [server/stalwart/](server/stalwart/) — `client.js` (loopback JMAP), `smtp.js`, `code.js`;
  [server/imap/client.js](server/imap/client.js) for the read-only IMAP pull.
- **HTTP:** [server/http/](server/http/) — `api.js`, `principal.js`, `person-routes.js`, `reading-routes.js`,
  `agent-mail.js`, `imap-routes.js`, `workspace-routes.js`, `cors.js`, `discovery.js`, `pages.js`, `mail-copy.js`.
- **Jobs:** [server/jobs/](server/jobs/) — `purge.js` (expiry), `agent-mail.js`, `inbox-ai.js`, `imap-pull.js`,
  `forwarding.js`, `workspace.js`.
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/): `mail_addresses`, `mail_directory_accounts`
  (the SQL directory view Stalwart reads), settings/outbox, rate limits, observed messages, mask expiry, agent
  answering, Inbox AI consent/triage, IMAP mailboxes, outbound providers/domains, person mail, workspace, spam
  scoring, `event_outbox` (with its rejected partial index).
- **Stalwart config:** [deploy/stalwart/config.toml](deploy/stalwart/config.toml) is the source of truth;
  `render.js` produces the data store and plan, `apply.js` reconciles over JMAP. It creates the SQL directory, the
  base/mask/burner domains (`allowRelaying = false`), the blob store (fs or S3), spam filter and exactly three
  listeners (SMTP 25, JMAP/management + IMAP on loopback); every default submission/HTTPS/POP3/Sieve listener is
  removed. The directory-created account gets the `User` role or Stalwart refuses its own mail.
- **Deploy:** [deploy/systemd/openvibe-mail.service](deploy/systemd/openvibe-mail.service) (API),
  [deploy/systemd/openvibe-stalwart.service](deploy/systemd/openvibe-stalwart.service) and
  [deploy/systemd/openvibe-stalwart.slice](deploy/systemd/openvibe-stalwart.slice) (memory cap),
  [deploy/nginx/openvibe.email.conf](deploy/nginx/openvibe.email.conf) (API/health/ready/auth; `/internal/` closed).
  M1 is **not deployed from this repository** — [docs/INSTALL.md](docs/INSTALL.md) is the operator's handoff.

## Ownership and Boundaries

Mail owns masks, burners, agent inboxes and their answering state, the directory view, person-mail addresses,
settings, observed message metadata, rate limits, Inbox AI consent/summaries/drafts, IMAP mailbox settings and the
outbox. It does **not** own identity/verified emails/trust (Network), mail delivery or blobs (Stalwart), event delivery
(Events), AI (the AI service), or the host/DNS (Host/operator). It never stores a message body as a row; message
content lives in Stalwart and is read on demand for its owner. Another person's mask, burner or inbox answers **404,
never 403**.

## Addresses, Reading and Sending

- **Masks** (`<site>.<code>@mask.openvibe.email`) deliver into the owner's mailbox; disabling one makes it bounce. A
  mask may carry `expires_days`; the purge job disables it and the directory stops resolving it.
- **Burners** are receive-only and expire after 10m/1h/1d/7d or the first message; the 10-minute burner needs no
  account and is read with its returned `x-mail-burner-token`. Every unexpired burner is its **own** directory
  account, so one burner's mail is never readable in another's. Expired: the mail is deleted, the account removed and
  the address bounces.
- **Agent inboxes** (`<name>.<owner>@openvibe.email`) are aliases on the owner's mailbox. Answering is a switch, **off
  by default**, turned on for one agent; the due poll then publishes `mail.agent_inbox.received` once per unseen
  non-spam, non-blocked letter. The agent reads with `mail.agent.read` and replies with `mail.agent.reply`, always
  from the agent's address to the sender and nobody else, plain text, with `In-Reply-To`/`References`.
- **Delivered-To:** a mask/agent inbox is matched only against the first `Delivered-To` header Stalwart stamps —
  never a sender-written To/Cc/Delivered-To. A burner's account is read with no recipient filtering at all.
- **HTML reading:** [server/domain/reading.js](server/domain/reading.js) sanitizes with an allow-list; `style` is
  limited to layout/colour with no `url()`, `expression()` or `@import`; links only http(s)/mailto with
  `rel="noopener noreferrer"`. Remote images become alt text (`blocked_images`) until `?images=1` (https only); the
  page renders it in an iframe with no `allow-scripts` and its own `default-src 'none'` CSP.
- **Person mail:** a person can create a named address/alias, compose plain text, attach a custom domain and forward a
  copy to a verified Network email. Sending needs a verified account email, a one-day-old account, a verified sender
  domain and a live trust check. 20 recipients/day rising to 50/100 with age and history; 10 recipients/message; no
  bulk mode. Hard bounces/complaints pause the sender; every message carries a report link and
  `X-OpenVibe-Report-Abuse`.
- **Forwarding** rechecks Network ownership at creation and before every copy; only non-junk plain-text messages
  without attachments are copied; an ambiguous provider answer is not retried automatically.
- **Outbound is closed by default.** `MAIL_OUTBOUND=on` plus an enabled provider is required; with it off, a reply to
  a non-OpenVibe address answers 409 `mail.outbound_closed` and stays pending, never lost.
- **IMAP pull** is TLS only, read-only, app password sealed with `MAIL_SECRETS_KEY`; it never writes back.
- Limits: 20 masks, 5 live burners/person; account-less 10-minute burners 10/IP/hour and 2,000 live globally
  (503 `mail.burner_capacity`); counters are in PostgreSQL, so a restart is not a fresh allowance.

## API and Scopes

All API routes are `/api/v1`, take a Network bearer or the same-site session cookie; a cross-origin browser may use a
Bearer from a first-party origin (CORS); a cookie write must come from openvibe.email (`Sec-Fetch-Site`/`Origin`).
An app token names the person (`on_behalf_of`) and holds `mail.addresses.write` or `mail.messages.read`; the
Companion-style token holds `mail.mask.manage`; a typed token is refused. A service acting for a person uses
`X-OV-Subject`.

Core routes: `GET /me/mail`, masks (`/masks`, `/:id`, `/:id/disable`), burners (`/burners`,
`/:id/messages`, `/:id/code`), agent inboxes (`/agent-inboxes`, `/:id/messages`, `/:id/answering`),
blocks (`/me/mail/blocks`), `GET|POST /me/mail/messages[...]` (reading, read/unread, delete, attachments),
person-mail/addresses/compose/domains/forwarding/IMAP/Inbox AI per [docs/INBOX-AI.md](docs/INBOX-AI.md), and the
internal agent routes. The message list returns `{ id, from, subject, received_at }` and nothing else; `/code`
returns the code, never the body.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter.
- **Never log a body, a subject, an address's mail or a code.** Metadata-only events: `mail.mask.created`,
  `mail.received` (address, sender, message id, time — no subject/body/code), `mail.agent_inbox.received` (excerpt
  ≤4000 chars, never HTML/attachment, nothing for spam/blocked).
- New schema = a new `migrations/NNNN_name.sql` (expand-only); never edit one that has run. The directory view is
  read by Stalwart, so a column change is a coordinated deploy.
- Stalwart config is **declarative**: edit [deploy/stalwart/config.toml](deploy/stalwart/config.toml), then render and
  apply. Never edit the rendered data store by hand or leave a default listener enabled.
- CSP: add origins to `helmet` in [server/app.js](server/app.js); the message iframe has its own stricter policy.
- Phone first: the one page and the inbox fit 390 px; no Font Awesome; "Calm reduces, only Off removes" (a block or
  disabled mask suppresses, only purge/delete removes).
- Empty states use the shared kit; keep the page's copy to what M1 does today (receive, show a code, never a body
  unless its owner asks).

## Key Pitfalls

- **One burner = one account.** Never pool or merge burners into one mailbox; a forgeable To/Cc/Delivered-To must not
  move mail between burners or agent inboxes. [test/stalwart/integration.test.js](test/stalwart/integration.test.js)
  proves it with a real Stalwart.
- **Directory vs expiry:** an expired/disabled address must resolve to no directory row and bounce; do not "keep it
  working" for a grace period.
- **Bodies:** only the owner reads a message; the code extractor must discard the body as soon as it has the code.
  An attachment is allow-listed/`application/octet-stream` with `nosniff`.
- **Outbound off** is the default safety: do not make a route that quietly sends externally because a provider key is
  present. `GET /internal/mail/outbound` tells callers the truth.
- **Inbox AI** is opt-in and consent-scoped; the draft is editable and is the only generated body persisted; a reply
  stays a draft until the person sends it (see [docs/INBOX-AI.md](docs/INBOX-AI.md)).
- **Custom domains:** verify DNS/ownership before accepting; the inbound path and states are in
  [docs/DNS.md](docs/DNS.md). Never show a domain as verified before it is.
- **Ports:** only 25 inbound is open; 587/465 stay closed. JMAP/IMAP listen on loopback. Do not expose them.
- **`event_outbox`** needs its rejected partial index (migration 0007).
- **M1 is not deployed from this repo.** Do not add a deploy step here; the operator follows INSTALL.md.

## Testing

`npm test` runs unit tests on PGlite with an in-process Network and an in-memory mail server: masks, burners, agent
inboxes/answering, directory, reading/sanitizing/images, person mail, provider adapters/router/webhooks, IMAP,
Inbox AI, purge, API/page, CORS/nginx, Stalwart client, companion masks, workspace and your-address. `npm run test:pg`
for PostgreSQL. `npm run test:stalwart` is the real acceptance run (real Stalwart + PostgreSQL) and also runs in CI.
Always `node --check` changed files.

## Documentation

- [README.md](README.md) — person mail, M1.5 reading, M1 pieces, API, events, agent answering, contracts, Stalwart,
  tests, layout, limits, install.
- [docs/INBOX-AI.md](docs/INBOX-AI.md) — consent, rules, journal, undo and receipts.
- [docs/INBOX.md](docs/INBOX.md), [docs/INSTALL.md](docs/INSTALL.md), [docs/DNS.md](docs/DNS.md).
- [deploy/stalwart/config.toml](deploy/stalwart/config.toml), [deploy/stalwart/VERSION](deploy/stalwart/VERSION),
  [SECURITY.md](SECURITY.md), [.env.example](.env.example).
