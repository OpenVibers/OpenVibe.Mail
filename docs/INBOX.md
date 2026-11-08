# Inbox workspace

`/inbox` puts mail below a single folder row on a phone. `/inbox/settings` contains addresses, custom domains, verified forwarding, Inbox AI, connected mailboxes, rules, masks, and per-address signatures. Settings sections remain visible and counted. The composer supports formatted text, To/Cc/Bcc, reply/reply all/forward, attachments, and local-time scheduling. Desktop shortcuts are listed by the `?` button.

## Delivery and storage

The workspace builds on the person-mail delivery controls from PR #29. It uses the same Network trust check, verified sender/DKIM checks, recipient-based daily allowance, abuse reports, provider budgets, suppression, and failover. A scheduled send repeats the policy checks at dispatch; permission at scheduling time does not grant permission forever.

Migration `0014_mail_workspace.sql` is expand-only. Draft payloads and attachments are persisted in the owner's outbox when Send is pressed. Ordinary unsent composer content remains in browser memory. There are at most 10 recipients, 10 attachments, 5 MiB per file, and 10 MiB total decoded attachments. The route has a separate 15 MiB JSON ceiling; other APIs retain their smaller body limits. Outbox creation is capped at 100 messages per account/day, while dispatch uses the stricter shared recipient allowance. These payloads contain private mail, are excluded from logs/events, and cascade with mailbox deletion.

Every submission carries an owner-scoped idempotency key. Send defaults to a 15-second delay; scheduled sends wait until both the scheduled time and undo window have passed. Cancel updates only `queued` rows. The worker atomically claims a row before delivery, preventing two workers or a simultaneous undo from both winning. Cancellation after a claim returns a conflict. Queued sends survive restarts. A lost transport acknowledgement or interrupted claim is shown as uncertain; it is never automatically retried. Per-recipient outcomes remain available, including partial failures. The worker runs once per second and handles 20 sends per tick; due times are earliest dispatch times, not delivery guarantees.

Sent message content is available from the owner's outbox and replies appear in the original conversation. Sent and pending views filter before pagination, with stable timestamp/ID cursors and 50 entries per page. Attachments are stored with the outbox payload in PostgreSQL; moving payloads to blob storage is a future capacity improvement, not required for delivery correctness.

## Search and organization

Search uses JMAP filters before pagination: `from:`, `to:`, `subject:`, quoted phrases, bare words, `has:attachment`, `after:YYYY-MM-DD`, and `before:YYYY-MM-DD`. Dates are UTC, after is inclusive and before is exclusive. Inbox excludes archived and snoozed messages. All mail includes them; trash is excluded. Stars, archive and labels are persisted as JMAP keywords; snooze deadlines are durable database rows. Wake-up and snooze extension serialize on the same mailbox lock. A due snooze returns the message to Inbox.

Conversation membership comes from JMAP Thread/get. List grouping covers the current loaded page; opening Conversation retrieves the full thread's message IDs. HTML messages remain server-cleaned and sandboxed; remote images stay off until requested. Attachment previews render only images or text; other types can be downloaded.

## API

The owner-scoped `/api/v1/me/mail/workspace` routes expose settings/signatures, messages with `q`, `folder`, `label`, `address`, and `cursor`, message actions, threads, send, outbox and cancellation. They use the existing mail read/write capabilities. Sending additionally requires a human principal. Custom-domain and address creation remain on the person-mail APIs; forwarding still accepts only destinations verified by Network.

## Verification

- `npm test -- workspace provider-adapters person-mail reading inbox-ai page`
- `OV_ALLOW_SUITE=1 npm test`
- `node scripts/inbox-proof.cjs` (Chrome and Playwright; `PLAYWRIGHT_PATH` can point to an installed Playwright package). The proof runs isolated local services, writes screenshots to `/tmp/mail-inbox-proof`, and checks 390/1280 px in Vibe/Daylight themes, compose, upload/preview, undo, reply all, search, settings, overflow and page errors.
- CI runs the real Stalwart acceptance test against PostgreSQL with both filesystem and S3 blobs. The acceptance test verifies keyword changes, search filters and Thread/get.

MIME is built with [Nodemailer's MailComposer](https://nodemailer.com/extras/mailcomposer) and parsed with [MailParser](https://nodemailer.com/extras/mailparser). Search and keywords follow [JMAP Mail, RFC 8621](https://www.rfc-editor.org/rfc/rfc8621.html). Provider mappings follow the send API references linked in `server/domain/provider-adapters.js`; SES receives raw MIME, and the JSON providers receive decoded HTML/text plus base64 attachments.
