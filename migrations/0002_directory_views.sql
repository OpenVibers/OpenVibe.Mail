-- phase: expand
-- OpenVibe.Mail — the rows Stalwart's SQL directory reads.
--
-- Stalwart asks the directory "who owns this address?" for every inbound recipient. One row means one address
-- resolves to one person's mailbox; no row means the address does not exist and the mail bounces. The rule is
-- simple and is the whole privacy model of M1:
--
--   * the mailbox itself resolves to itself, so the account Stalwart creates for an alias has a primary
--     address the local delivery can find (and mail to <user>@openvibe.email is not a relay attempt);
--   * a mask that is on resolves to its owner's mailbox;
--   * a burner that has not expired resolves to **its own** mailbox: the burner address is its own Stalwart
--     directory account, so its mail never shares an account with another burner (anonymous or owned);
--   * an agent's inbox resolves to its owner's mailbox;
--   * a mask that is off, a burner that has expired, and a burner that took its one message resolve to nothing —
--     so the address bounces.
--
-- `name` is the primary address of the Stalwart account the row resolves to. For a person it is their mailbox
-- address, and masks/agent inboxes are aliases of it; for a burner it is the burner address itself. `secret` is
-- empty on purpose: the accounts have no password, so they can receive but never log in.
--
-- The view reads the moment, not the row: `now()` is evaluated per query, so a burner stops resolving the second
-- it expires even if the purge job has not run yet.

CREATE OR REPLACE VIEW mail_directory_accounts AS
    SELECT mb.address                      AS address,
           mb.address                      AS name,
           mb.owner_subject                AS owner,
           ''::text                        AS secret,
           'mailbox'::text                 AS description
      FROM mail_mailboxes mb
    UNION ALL
    SELECT m.address                       AS address,
           mb.address                      AS name,
           m.owner_subject                 AS owner,
           ''::text                        AS secret,
           'mask'::text                    AS description
      FROM mail_masks m
      JOIN mail_mailboxes mb ON mb.owner_subject = m.owner_subject
     WHERE m.enabled
    UNION ALL
    SELECT b.address                       AS address,
           b.address                       AS name,
           b.owner_subject                 AS owner,
           ''::text                        AS secret,
           'burner'::text                  AS description
      FROM mail_burners b
     WHERE b.expires_at > now()
       AND (NOT b.first_message_only OR b.first_message_at IS NULL)
    UNION ALL
    SELECT a.address                       AS address,
           mb.address                      AS name,
           a.owner_subject                 AS owner,
           ''::text                        AS secret,
           'agent inbox'::text             AS description
      FROM mail_agent_inboxes a
      JOIN mail_mailboxes mb ON mb.owner_subject = a.owner_subject;
