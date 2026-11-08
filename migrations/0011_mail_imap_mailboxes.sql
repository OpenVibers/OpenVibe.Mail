-- phase: expand
-- Pulling a person's other mailbox over IMAP (Inbox AI). The password is sealed with AES-256-GCM under
-- MAIL_SECRETS_KEY before it reaches this table; it is never returned by an API route and never logged.
--
-- last_uid/uid_validity are the read position on the remote INBOX: a run reads only UIDs above last_uid and resets
-- to 0 when the server's UIDVALIDITY changes. next_sync_at is when the connection is due again, so the job checks
-- due rows instead of every connection on every tick.
CREATE TABLE IF NOT EXISTS mail_imap_mailboxes (
    id            text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    host          text NOT NULL,
    port          integer NOT NULL DEFAULT 993 CHECK (port BETWEEN 1 AND 65535),
    username      text NOT NULL,
    secret        text NOT NULL,
    uid_validity  text,
    last_uid      bigint NOT NULL DEFAULT 0,
    last_sync_at  timestamptz,
    last_error    text,
    next_sync_at  timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_imap_mailboxes_owner_address_idx
    ON mail_imap_mailboxes (owner_subject, host, port, username);
CREATE INDEX IF NOT EXISTS mail_imap_mailboxes_due_idx ON mail_imap_mailboxes (next_sync_at);

-- Where a triage row came from, so Disconnect can delete the summaries pulled through one connection and keep
-- forwarded mail. A connection removed without deleting its summaries leaves the rows with no id.
ALTER TABLE mail_inbox_ai_threads ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'forwarded';
ALTER TABLE mail_inbox_ai_threads ADD COLUMN IF NOT EXISTS imap_mailbox_id text
    REFERENCES mail_imap_mailboxes (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS mail_inbox_ai_threads_imap_idx ON mail_inbox_ai_threads (imap_mailbox_id);
