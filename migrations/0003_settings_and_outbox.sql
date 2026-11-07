-- phase: expand
-- OpenVibe.Mail — the service's own settings, and the events outbox.
--
-- The settings table holds one thing today: the mailbox that receives the mail of a burner made without an account.
-- It is a row and not a constant because the directory view (0002) has to read it: an account-less burner resolves to
-- that mailbox, so its mail lands somewhere the service can read and delete when the burner expires.

CREATE TABLE IF NOT EXISTS mail_settings (
    key         text PRIMARY KEY,
    value       text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The events outbox (ADR-004): mail.received and mail.mask.created are written in the same transaction as the change
-- that caused them, and the relay publishes them to OpenVibe.Events.
--
-- The shape is the SDK's (openvibe-sdk/outbox): the times are epoch milliseconds, and a row that was refused for
-- good is kept with rejected_at set, so a bad envelope is looked at rather than sent again and again.
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);

CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
