-- Run once in the Supabase SQL editor before starting alert-service.
-- These tables are separate from the existing base-bot tables.

-- Deduplication: prevents repeat alerts for the same event
CREATE TABLE IF NOT EXISTS alert_dedup (
  id        BIGSERIAL PRIMARY KEY,
  alert_key TEXT        UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS alert_dedup_created_idx ON alert_dedup (created_at);

-- Audit log of every alert that was (or would have been) posted
CREATE TABLE IF NOT EXISTS alert_log (
  id         BIGSERIAL PRIMARY KEY,
  alert_type TEXT        NOT NULL,
  alert_key  TEXT        NOT NULL,
  tweet_text TEXT,
  tweet_id   TEXT,
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS alert_log_type_idx ON alert_log (alert_type, created_at DESC);

-- Configurable smart-wallet watch list (managed via Supabase dashboard or TRACKED_WALLETS env var)
CREATE TABLE IF NOT EXISTS tracked_wallets (
  id         BIGSERIAL PRIMARY KEY,
  address    TEXT        UNIQUE NOT NULL,
  label      TEXT,
  active     BOOLEAN     DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pool metric snapshots for trending detection (older than 48 h are auto-pruned)
CREATE TABLE IF NOT EXISTS pool_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  pool_address    TEXT        NOT NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  volume_usd_1h   NUMERIC,
  volume_usd_24h  NUMERIC,
  reserve_usd     NUMERIC,
  swap_count_1h   INTEGER,
  buyer_count_1h  INTEGER
);
CREATE INDEX IF NOT EXISTS pool_snapshots_pool_idx ON pool_snapshots (pool_address, snapshot_at DESC);

-- Per-wallet token positions (used to detect new positions and coordinated buys)
CREATE TABLE IF NOT EXISTS wallet_positions (
  id             BIGSERIAL PRIMARY KEY,
  wallet_address TEXT        NOT NULL,
  token_address  TEXT        NOT NULL,
  token_symbol   TEXT,
  first_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (wallet_address, token_address)
);
CREATE INDEX IF NOT EXISTS wallet_positions_token_idx ON wallet_positions (token_address, last_seen_at DESC);
