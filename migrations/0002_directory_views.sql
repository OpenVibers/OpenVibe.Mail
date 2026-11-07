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
--   * a burner that has not expired resolves to its owner's mailbox — or, for a burner made without an account,
--     to the service's own pool mailbox (owner_subject 'service:burner-pool'), where the service reads the code
--     and deletes the mail when the burner expires;
--   * an agent's inbox resolves to its owner's mailbox;
--   * a mask that is off, a burner that has expired, and a burner that took its one message resolve to nothing —
--     so the address bounces.
--
-- `name` is the owner's mailbox address in Stalwart (the account Stalwart synchronises); `secret` is empty on
-- purpose: the account has no password, so it can receive but never log in. The address is also the alias the
-- account is given, which is how the local delivery finds the mailbox again.
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
           COALESCE(
               mb.address,
               (SELECT address FROM mail_mailboxes WHERE owner_subject = 'service:burner-pool')
           )                               AS name,
           b.owner_subject                 AS owner,
           ''::text                        AS secret,
           'burner'::text                  AS description
      FROM mail_burners b
      LEFT JOIN mail_mailboxes mb ON mb.owner_subject = b.owner_subject
     WHERE b.expires_at > now()
       AND (NOT b.first_message_only OR b.first_message_at IS NULL)
       AND (
           mb.address IS NOT NULL
           OR EXISTS (SELECT 1 FROM mail_mailboxes WHERE owner_subject = 'service:burner-pool')
       )
    UNION ALL
    SELECT a.address                       AS address,
           mb.address                      AS name,
           a.owner_subject                 AS owner,
           ''::text                        AS secret,
           'agent inbox'::text             AS description
      FROM mail_agent_inboxes a
      JOIN mail_mailboxes mb ON mb.owner_subject = a.owner_subject;
