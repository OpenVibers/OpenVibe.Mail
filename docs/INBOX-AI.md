# Inbox AI

Inbox AI is off until the mailbox owner opts in at **Inbox → Inbox AI**. Gmail forwarding to the person's
`@openvibe.email` address is supported by normal mail delivery. Pulling mail from another provider over IMAP is a
later step.

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
- `GET /api/v1/me/mail/receipts` is the read-only handoff for openvibe.my: `{ enabled, receipts: [{ thread_id,
  message_id, merchant, subject, summary, received_at }] }`. `enabled` is the mailbox's Inbox AI opt-in; when it is
  off or there is no mailbox, `receipts` is empty. It contains only the person's own receipt-category summaries.

These routes require a person token and are private/no-store. Rule journals never contain message bodies.
