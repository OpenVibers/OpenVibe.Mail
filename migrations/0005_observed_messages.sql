-- phase: expand
-- OpenVibe.Mail — the messages the service has already seen.
--
-- The service reads a person's mailbox when somebody asks for a burner's messages or its code. Every message it
-- sees is written here, once per address, and the first time it is seen the service publishes mail.received. The
-- row is the answer to "have I already told the world about this message?" — without it the same letter would be
-- announced again on every read.
--
-- Only the address, the message id and the time are kept. The body is never written down.

CREATE TABLE IF NOT EXISTS mail_observed_messages (
    address       text NOT NULL,
    message_id    text NOT NULL,
    received_at   timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (address, message_id)
);

CREATE INDEX IF NOT EXISTS mail_observed_messages_seen_idx ON mail_observed_messages (first_seen_at);
