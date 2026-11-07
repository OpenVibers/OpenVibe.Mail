-- phase: expand
-- OpenVibe.Mail — the counters behind the abuse limits.
--
-- A burner made without an account is the one thing anybody on the internet can ask for, so it is limited twice:
-- by the address it came from (ten an hour) and by how many are alive at once (five). The counters live here, not in
-- memory, so a restart does not hand everybody a fresh allowance.
--
-- One row per (key, window). The key says what is being counted — 'burner:ip:<address>' — and the window says
-- when it started. When the window is over the row is replaced and the count starts again.

CREATE TABLE IF NOT EXISTS mail_rate_limits (
    key            text PRIMARY KEY,
    window_started_at timestamptz NOT NULL,
    count          integer NOT NULL DEFAULT 0,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_rate_limits_window_idx ON mail_rate_limits (window_started_at);
