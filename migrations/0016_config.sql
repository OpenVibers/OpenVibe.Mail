-- phase: expand
-- The owner's mail settings: the revisioned-configuration journal of openvibe-shared/config on PostgreSQL
-- (configSchema() in that package's config-pg.js). Mail keeps three namespaces here: mail.sending (the sending
-- providers and the SMTP relay), mail.receiving (Cloudflare Email Routing) and mail.dns (the DNS check of a
-- sending domain). The runtime role creates no tables, so a service's migrations own them (Billing's
-- 0013_config.sql and Network's 0006_config.sql are the pattern).

CREATE TABLE IF NOT EXISTS config_snapshots (
    namespace            text COLLATE "C" NOT NULL,
    revision             bigint NOT NULL,
    service              text COLLATE "C" NOT NULL,
    previous_revision    bigint,
    state                text COLLATE "C" NOT NULL CHECK (state IN ('proposed', 'active', 'superseded', 'rejected', 'rolled_back')),
    values_json          text COLLATE "C" NOT NULL,
    classification_json  text COLLATE "C" NOT NULL,
    values_checksum      text COLLATE "C" NOT NULL,
    created_at           text COLLATE "C" NOT NULL,
    created_by           text COLLATE "C" NOT NULL,
    activated_at         text COLLATE "C",
    activated_by         text COLLATE "C",
    reason               text COLLATE "C",
    error                text COLLATE "C",
    copied_from          bigint,
    good                 bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (namespace, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS config_snapshots_one_active ON config_snapshots (namespace) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS config_keys (
    namespace   text COLLATE "C" PRIMARY KEY,
    hmac_key    bytea NOT NULL,
    created_at  text COLLATE "C" NOT NULL
);
