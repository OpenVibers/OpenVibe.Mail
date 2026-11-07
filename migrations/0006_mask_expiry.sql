-- phase: expand
-- OpenVibe.Mail — a mask can be given a life.
--
-- POST /api/v1/masks accepts expires_days: the mask turns itself off when the date arrives, so a per-site address
-- made for one purchase does not outlive the purchase by accident. expires_at is when that happens; NULL means the
-- mask lives until the person turns it off. The purge job disables the due rows (enabled = false), and the SQL
-- directory Stalwart reads stops resolving them in the same moment.
--
-- The Contract resource (mail.mask@1) stays as it is: it has no expiry field, so only /me/mail's listing metadata
-- carries expires_at.

ALTER TABLE mail_masks ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS mail_masks_due_idx ON mail_masks (expires_at) WHERE enabled AND expires_at IS NOT NULL;
