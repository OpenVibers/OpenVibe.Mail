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
    secure boolean NOT NULL DEFAULT false,
    starttls boolean NOT NULL DEFAULT true,
    enabled boolean NOT NULL DEFAULT false,
    priority integer NOT NULL DEFAULT 100,
    free_monthly integer NOT NULL DEFAULT 0 CHECK (free_monthly >= 0),
    price_per_thousand numeric(12,6) NOT NULL DEFAULT 0 CHECK (price_per_thousand >= 0),
    monthly_budget numeric(12,4) NOT NULL DEFAULT 0 CHECK (monthly_budget >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_outbound_usage (
    provider_id text NOT NULL REFERENCES mail_outbound_providers(id) ON DELETE CASCADE,
    month date NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    PRIMARY KEY (provider_id, month)
);
