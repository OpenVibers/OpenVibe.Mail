# Inbox AI

Inbox AI is off until the mailbox owner opts in at **Inbox → Inbox AI**. Gmail forwarding to the person's
`@openvibe.email` address is supported by normal mail delivery; pulling mail from another provider over IMAP is
described below.

When enabled, Mail polls new JMAP threads, asks OpenVibe.AI to classify and summarize them, and stores the result in
Mail. Runs are attributed to the mailbox owner with `on_behalf_of` and use the `openvibe/private` tier, so mail is
not sent to a third-party model. Mail content is not used for training. A Needs a reply item is an editable draft;
the send route runs only after the person explicitly clicks Send. Outbound relay policy still applies.

## Person API

- `GET|PUT /api/v1/me/mail/ai-settings` reads or changes the mailbox's opt-in (`{ "enabled": true|false }`).
- `GET /api/v1/me/mail/triage` returns counts and up to 200 threads grouped as `needs_reply`, `to_read`, `receipts`,
  `newsletters`, and `other`.
- `PUT /api/v1/me/mail/triage/{thread_id}/draft` saves an edited subject and body.
- `POST /api/v1/me/mail/triage/{thread_id}/send` sends that draft after a user action. It is never called by triage.
- `GET|POST /api/v1/me/mail/ai-rules`, `PUT|DELETE /api/v1/me/mail/ai-rules/{id}` manage rules. A rule matches an
  exact sender address and/or subject substring and assigns a category.
- `GET /api/v1/me/mail/ai-journal` lists category changes made by rules. `POST
  /api/v1/me/mail/ai-journal/{id}/undo` restores the previous category when the thread has not since changed.
- `GET /api/v1/me/mail/receipts` is the read-only handoff for openvibe.my: `{ receipts: [{ thread_id, merchant,
  subject, summary, received_at }] }`. It contains only the person's own receipt-category summaries.

These routes require a person token and are private/no-store. Rule journals never contain message bodies.

## Pulling another mailbox over IMAP

A person who has Inbox AI on can connect an outside mailbox. The normal account password is not what these
providers expect for IMAP; use an app password:

- **Gmail**: turn on 2-Step Verification, then create an App password for “Mail”. Host `imap.gmail.com`, port 993,
  username is the full Gmail address.
- **Outlook / Microsoft 365**: an app password is available when the account uses multi-factor sign-in; a
  Microsoft 365 administrator may also need to allow IMAP for the mailbox. Host `outlook.office365.com`, port 993,
  username is the full address.

- `GET /api/v1/me/mail/imap-mailboxes` lists the person's connections with `last_sync_at` and a plain-words
  `last_error`. It never returns a password or the sealed value.
- `POST /api/v1/me/mail/imap-mailboxes` takes `{ host, username, password }` (`port`, if sent, must be 993), tests the connection
  before saving it, and answers 422 with one sentence when the host, certificate, sign-in or TLS fails. A failed test
  leaves no row. Inbox AI must be on (409 otherwise), the host must be a public DNS name, a person connects at most
  five mailboxes (409), and ten attempts an hour (429).
- `DELETE /api/v1/me/mail/imap-mailboxes/{id}` deletes the credential. With `?delete_triage=1` it also deletes the
  summaries and drafts pulled through that connection; without it those rows stay.

The connection is TLS only (implicit TLS on port 993 only; there is no plaintext mode and no other port) and the host goes
through `openvibe-shared/egress`, so a name that resolves to a private, loopback or link-local address is refused
before the handshake. The app password is sealed with AES-256-GCM under `MAIL_SECRETS_KEY` before it is stored, with
the person and connection id as the additional authenticated data. Without that key the feature answers 503 and no
connection can be saved.

A poll reads only the remote `INBOX`, read only: it opens the mailbox with EXAMINE and fetches with `BODY.PEEK`, so
it never sets `\Seen` and never deletes, moves or stores anything on the remote server. Each connection is due on
its own schedule (`MAIL_IMAP_INTERVAL_MS`, five minutes by default); one run reads at most
`MAIL_IMAP_MAX_MESSAGES` new messages and hands at most `MAIL_IMAP_MAX_BYTES` of text per message to the analyzer.
The read position is the last UID plus the server's UIDVALIDITY: only higher UIDs are read, and a changed
UIDVALIDITY starts again. The first poll starts at the UID that existed when the connection was tested, so
connecting does not scan the provider's whole archive. A remote junk message is skipped but its UID is passed. Messages pulled this way go
through the same categories, rules, journal, drafts and receipts as forwarded mail; `needs_reply` drafts answer the
sender the pull stored, and Sending still waits for the person's click.

Limits: `MAIL_IMAP_MAX_MAILBOXES` connections per person (five by default), `MAIL_IMAP_BATCH` connections per run,
and the poll runs under its own lease in `mail_settings` so two instances do not read one connection twice. Error
text is one plain sentence — never the provider's response, a subject, a sender or the password.
