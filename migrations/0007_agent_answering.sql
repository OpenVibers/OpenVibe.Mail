-- phase: expand
-- OpenVibe.Mail — an agent answers the mail sent to its own address (track HO6, channels).
--
-- An agent's inbox already exists (0001) and its mail lands in the person's mailbox. What this adds is the two
-- things answering needs:
--
--   * the switch, per inbox and OFF unless the person turns it on: an address that exists is not an invitation to
--     answer, and a person turns it on for the agent they trust to. A row exists only once the person has set the
--     switch; no row means off.
--   * what the agent's system has already been told about, so a message is announced once even when two poll runs
--     overlap, and so the agent's own reply is never answered as if it were a letter.
--
-- Expand only: new tables and a new column with a default; the previous release reads neither. The poll that writes
-- them takes mail_settings' own lease (the purge job's key is separate), so a second instance does nothing twice.

CREATE TABLE IF NOT EXISTS mail_inbox_answering (
    inbox_id      text PRIMARY KEY REFERENCES mail_agent_inboxes (id) ON DELETE CASCADE,
    owner_subject text NOT NULL,
    enabled       boolean NOT NULL DEFAULT false,
    changed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_inbox_answering_owner_idx ON mail_inbox_answering (owner_subject);

-- One row per (inbox, message) the agent's system has been told about. The row is written in the transaction that
-- queues the event, so an event cannot exist for a row that did not commit: that is what makes the poll idempotent.
CREATE TABLE IF NOT EXISTS mail_agent_mail (
    inbox_id      text NOT NULL REFERENCES mail_agent_inboxes (id) ON DELETE CASCADE,
    message_id    text NOT NULL,
    owner_subject text NOT NULL,
    from_address  text,
    announced_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (inbox_id, message_id)
);

CREATE INDEX IF NOT EXISTS mail_agent_mail_owner_idx ON mail_agent_mail (owner_subject, created_at DESC);

-- A sender a person's agent never hears from. Per owner, because a block is a person's decision and not a
-- network-wide one; the address is stored lowercased and exact. A blocked sender is never announced, so nothing
-- ever starts for one.
CREATE TABLE IF NOT EXISTS mail_blocked_senders (
    owner_subject text NOT NULL,
    address       text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_subject, address)
);

-- What an agent's address has sent. Not the mail server's copy (that is in the Sent mailbox over JMAP): this is the
-- record of the act, written with its outcome, so the person can read what left in their agent's name and what did
-- not, and so a retried send is one row. `reason` says why a send did not happen, in plain words, never a secret.
CREATE TABLE IF NOT EXISTS mail_sent_mail (
    inbox_id       text NOT NULL REFERENCES mail_agent_inboxes (id) ON DELETE CASCADE,
    owner_subject  text NOT NULL,
    rfc_message_id text NOT NULL,
    to_address     text NOT NULL,
    subject        text,
    sent           boolean NOT NULL DEFAULT false,
    reason         text,
    transport      text NOT NULL DEFAULT 'none',
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (inbox_id, rfc_message_id)
);

CREATE INDEX IF NOT EXISTS mail_sent_mail_owner_idx ON mail_sent_mail (owner_subject, created_at DESC);
