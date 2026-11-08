-- phase: expand
-- Inbox AI is a per-mailbox opt-in. Absence of a row means off, including for existing accounts.
CREATE TABLE IF NOT EXISTS mail_inbox_ai_consent (
    owner_subject text PRIMARY KEY REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    enabled       boolean NOT NULL DEFAULT false,
    changed_at    timestamptz NOT NULL DEFAULT now()
);
