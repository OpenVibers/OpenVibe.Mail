-- phase: expand
-- Person-owned addresses, custom domains, outbound allowance and verified forwarding.
CREATE TABLE IF NOT EXISTS mail_custom_domains (
    domain text NOT NULL,
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    ownership_token text NOT NULL,
    ownership_verified_at timestamptz,
    mx_verified_at timestamptz,
    dkim_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (domain, owner_subject)
);
CREATE INDEX IF NOT EXISTS mail_custom_domains_owner ON mail_custom_domains(owner_subject);
CREATE UNIQUE INDEX IF NOT EXISTS mail_custom_domains_verified_domain ON mail_custom_domains(domain) WHERE ownership_verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_person_addresses (
    address text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('name','alias','custom')),
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_person_addresses_owner ON mail_person_addresses(owner_subject,created_at);

CREATE TABLE IF NOT EXISTS mail_person_daily (
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    day date NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    accepted integer NOT NULL DEFAULT 0 CHECK (accepted >= 0),
    PRIMARY KEY(owner_subject,day)
);
CREATE TABLE IF NOT EXISTS mail_person_sends (
    id text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    sender text NOT NULL,
    recipient text NOT NULL,
    provider_id text,
    provider_message_id text,
    status text NOT NULL CHECK(status IN ('sending','accepted','failed','uncertain','bounced','complaint')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_person_sends_owner ON mail_person_sends(owner_subject,created_at DESC);
CREATE INDEX IF NOT EXISTS mail_person_sends_provider_message ON mail_person_sends(provider_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS mail_person_reports (
    send_id text PRIMARY KEY REFERENCES mail_person_sends(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_forward_rules (
    id text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    source_address text,
    target_address text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(owner_subject,source_address,target_address)
);
CREATE INDEX IF NOT EXISTS mail_forward_rules_owner ON mail_forward_rules(owner_subject);
CREATE TABLE IF NOT EXISTS mail_forward_daily (
    owner_subject text NOT NULL REFERENCES mail_mailboxes(owner_subject) ON DELETE CASCADE,
    day date NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    PRIMARY KEY(owner_subject,day)
);
CREATE TABLE IF NOT EXISTS mail_forward_deliveries (
    rule_id text NOT NULL REFERENCES mail_forward_rules(id) ON DELETE CASCADE,
    message_id text NOT NULL,
    state text NOT NULL CHECK(state IN ('sending','sent','failed')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(rule_id,message_id)
);

CREATE OR REPLACE VIEW mail_directory_accounts AS
    SELECT mb.address,mb.address AS name,mb.owner_subject AS owner,''::text AS secret,'mailbox'::text AS description FROM mail_mailboxes mb
    UNION ALL SELECT m.address,mb.address,m.owner_subject,''::text,'mask'::text FROM mail_masks m JOIN mail_mailboxes mb USING(owner_subject) WHERE m.enabled
    UNION ALL SELECT b.address,b.address,b.owner_subject,''::text,'burner'::text FROM mail_burners b WHERE b.expires_at > now() AND (NOT b.first_message_only OR b.first_message_at IS NULL)
    UNION ALL SELECT a.address,mb.address,a.owner_subject,''::text,'agent inbox'::text FROM mail_agent_inboxes a JOIN mail_mailboxes mb USING(owner_subject)
    UNION ALL SELECT p.address,mb.address,p.owner_subject,''::text,'person address'::text FROM mail_person_addresses p JOIN mail_mailboxes mb USING(owner_subject)
        WHERE p.enabled AND (p.kind <> 'custom' OR EXISTS (
            SELECT 1 FROM mail_custom_domains d WHERE d.domain=split_part(p.address,'@',2)
                AND d.owner_subject=p.owner_subject AND d.ownership_verified_at IS NOT NULL AND d.mx_verified_at IS NOT NULL));
