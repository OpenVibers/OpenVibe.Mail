-- phase: expand
-- Owner-managed outbound SMTP providers. Credentials are ciphertext produced by the service KEK.
CREATE TABLE IF NOT EXISTS mail_outbound_providers (
    id text PRIMARY KEY,
    adapter text NOT NULL DEFAULT 'smtp',
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    name text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
    username text,
    credential_ciphertext text,
    credential_nonce text,
    credential_tag text,
    webhook_secret_ciphertext text,
    webhook_secret_nonce text,
    webhook_secret_tag text,
    secure boolean NOT NULL DEFAULT false,
    starttls boolean NOT NULL DEFAULT true,
    enabled boolean NOT NULL DEFAULT false,
    priority integer NOT NULL DEFAULT 100,
    free_monthly integer NOT NULL DEFAULT 0 CHECK (free_monthly >= 0),
    free_daily integer NOT NULL DEFAULT 0 CHECK (free_daily >= 0),
    price_per_thousand numeric(12,6) NOT NULL DEFAULT 0 CHECK (price_per_thousand >= 0),
    monthly_budget numeric(12,4) NOT NULL DEFAULT 0 CHECK (monthly_budget >= 0),
    rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 100000),
    enabled_kinds jsonb NOT NULL DEFAULT '["system","person"]'::jsonb,
    health_failures integer NOT NULL DEFAULT 0 CHECK (health_failures >= 0),
    health_open_until timestamptz,
    health_probe_until timestamptz,
    last_health_at timestamptz,
    last_health text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_outbound_usage (
    provider_id text NOT NULL REFERENCES mail_outbound_providers(id) ON DELETE CASCADE,
    month date NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    sent integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
    PRIMARY KEY (provider_id, month)
);

CREATE TABLE IF NOT EXISTS mail_outbound_daily_usage (
    provider_id text NOT NULL REFERENCES mail_outbound_providers(id) ON DELETE CASCADE,
    day date NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    sent integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
    PRIMARY KEY (provider_id, day)
);

CREATE TABLE IF NOT EXISTS mail_outbound_rate_usage (
    provider_id text NOT NULL REFERENCES mail_outbound_providers(id) ON DELETE CASCADE,
    minute_bucket timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    PRIMARY KEY (provider_id, minute_bucket)
);

CREATE TABLE IF NOT EXISTS mail_outbound_suppressions (
    address text PRIMARY KEY,
    reason text NOT NULL CHECK (reason IN ('hard_bounce','complaint','owner_block')),
    source_provider text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_outbound_deliverability (
    provider_id text NOT NULL REFERENCES mail_outbound_providers(id) ON DELETE CASCADE,
    recipient_domain text NOT NULL,
    delivered integer NOT NULL DEFAULT 0 CHECK (delivered >= 0),
    bounced integer NOT NULL DEFAULT 0 CHECK (bounced >= 0),
    complaints integer NOT NULL DEFAULT 0 CHECK (complaints >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_id, recipient_domain)
);

CREATE TABLE IF NOT EXISTS mail_outbound_webhook_events (
    provider_id text NOT NULL REFERENCES mail_outbound_providers(id) ON DELETE CASCADE,
    event_id text NOT NULL,
    recipient text NOT NULL,
    recipient_domain text NOT NULL,
    kind text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_id, event_id)
);

CREATE TABLE IF NOT EXISTS mail_outbound_domains (
    provider_id text NOT NULL REFERENCES mail_outbound_providers(id) ON DELETE CASCADE,
    domain text NOT NULL,
    dkim_records jsonb NOT NULL DEFAULT '[]'::jsonb,
    return_path text,
    spf_include text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(provider_id, domain)
);
