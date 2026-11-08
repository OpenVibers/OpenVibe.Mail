-- phase: expand
-- One AI summary/draft per JMAP thread. Message content is never copied to the AI queue or a journal row.
CREATE TABLE IF NOT EXISTS mail_inbox_ai_threads (
    owner_subject text NOT NULL REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    thread_id     text NOT NULL,
    message_id    text NOT NULL,
    category      text NOT NULL CHECK (category IN ('needs_reply', 'to_read', 'receipts', 'newsletters', 'other')),
    summary       text NOT NULL,
    draft_to      text,
    draft_subject text,
    draft_body    text,
    draft_state   text NOT NULL DEFAULT 'draft' CHECK (draft_state IN ('draft', 'sending', 'sent')),
    received_at   timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_subject, thread_id)
);
CREATE INDEX IF NOT EXISTS mail_inbox_ai_threads_owner_category_idx
    ON mail_inbox_ai_threads (owner_subject, category, received_at DESC);
