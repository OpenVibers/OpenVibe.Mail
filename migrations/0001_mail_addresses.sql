-- phase: expand
-- OpenVibe.Mail — the addresses we own.
--
-- A mask is a per-site address that delivers into OpenVibe and nowhere else; a burner is a throwaway address with
-- an expiry; an agent's inbox is an address an agent can read and answer from. Each of them belongs to a person
-- (owner_subject, the Network subject id) except a ten-minute burner, which may be created without an account.
--
-- The mailbox table says where a person's mail lands: one Stalwart account per person, addressed
-- <local>@<MAIL_BASE_DOMAIN>. The directory view (0002) turns the three tables below into the rows Stalwart's SQL
-- directory reads.

CREATE TABLE IF NOT EXISTS mail_mailboxes (
    owner_subject text PRIMARY KEY,
    address       text NOT NULL UNIQUE,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_masks (
    id            text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    address       text NOT NULL UNIQUE,
    label         text,
    purpose       text,
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_masks_owner_idx ON mail_masks (owner_subject, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_burners (
    id                text PRIMARY KEY,
    owner_subject     text REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    address           text NOT NULL UNIQUE,
    token_hash        text,
    guest_id          text,
    expires_at        timestamptz NOT NULL,
    first_message_only boolean NOT NULL DEFAULT false,
    first_message_at  timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_burners_owner_idx ON mail_burners (owner_subject, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_burners_expiry_idx ON mail_burners (expires_at);

CREATE TABLE IF NOT EXISTS mail_agent_inboxes (
    id            text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES mail_mailboxes (owner_subject) ON DELETE CASCADE,
    agent_id      text NOT NULL,
    address       text NOT NULL UNIQUE,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_agent_inboxes_owner_idx ON mail_agent_inboxes (owner_subject, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_agent_inboxes_agent_idx ON mail_agent_inboxes (agent_id);
-- One agent has one inbox: asking twice gives the same address.
CREATE UNIQUE INDEX IF NOT EXISTS mail_agent_inboxes_owner_agent_idx ON mail_agent_inboxes (owner_subject, agent_id);
