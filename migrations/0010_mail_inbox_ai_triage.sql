-- phase: expand
-- One AI summary/draft per JMAP thread. Message content is never copied to the AI queue or a journal row.
CREATE TABLE IF NOT EXISTS mail_inbox_ai_threads (
    owner_subject text NOT NULL REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    thread_id     text NOT NULL,
    message_id    text NOT NULL,
    sender        text,
    subject       text,
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

CREATE TABLE IF NOT EXISTS mail_inbox_ai_rules (
    id            text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    name          text NOT NULL,
    match_from    text,
    match_subject text,
    category      text NOT NULL CHECK (category IN ('needs_reply', 'to_read', 'receipts', 'newsletters', 'other')),
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (match_from IS NOT NULL OR match_subject IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS mail_inbox_ai_rules_owner_idx ON mail_inbox_ai_rules (owner_subject, created_at);

CREATE TABLE IF NOT EXISTS mail_inbox_ai_journal (
    id               text PRIMARY KEY,
    owner_subject    text NOT NULL REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    rule_id          text NOT NULL,
    rule_name        text NOT NULL,
    thread_id        text NOT NULL,
    previous_category text NOT NULL,
    action_category  text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    undone_at        timestamptz
);
CREATE INDEX IF NOT EXISTS mail_inbox_ai_journal_owner_idx ON mail_inbox_ai_journal (owner_subject, created_at DESC);
