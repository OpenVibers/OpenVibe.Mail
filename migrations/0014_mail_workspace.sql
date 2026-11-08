-- phase: expand
CREATE TABLE IF NOT EXISTS mail_compose_outbox (
    id text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    request_id text NOT NULL,
    payload jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','sending','sent','failed','uncertain','cancelled')),
    send_at timestamptz NOT NULL,
    undo_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    outcomes jsonb NOT NULL DEFAULT '[]',
    UNIQUE(owner_subject, request_id)
);
CREATE INDEX IF NOT EXISTS mail_compose_due ON mail_compose_outbox(send_at) WHERE state='queued';
CREATE TABLE IF NOT EXISTS mail_message_snoozes (
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    message_id text NOT NULL,
    wake_at timestamptz NOT NULL,
    PRIMARY KEY(owner_subject, message_id)
);
CREATE TABLE IF NOT EXISTS mail_address_signatures (
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    address text NOT NULL,
    signature text NOT NULL DEFAULT '',
    PRIMARY KEY(owner_subject, address)
);
CREATE TABLE IF NOT EXISTS mail_user_labels (
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    name text NOT NULL,
    PRIMARY KEY(owner_subject, name)
);
