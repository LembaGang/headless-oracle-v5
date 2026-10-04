-- Migration 0002 (chirindo_witness) — Witness accounts and per-pool day usage (witness spec v0.5)
--
-- A POST with an Evidence plan key stores its row with account_id (the first
-- 32 hex characters of the key's SHA-256); an anonymous row leaves it NULL.
-- The signed receipt is unchanged and never carries it.
--
-- witness_usage counts new rows per (UTC day, pool), pool being 'anon' or an
-- account_id, through one primary-key upsert per new row:
--   INSERT INTO witness_usage (day, pool, n) VALUES (?, ?, 1)
--   ON CONFLICT (day, pool) DO UPDATE SET n = n + 1 RETURNING n
-- It replaces the max(rowid) day count of v0.4.
--
-- Mirrors ensureWitnessSchema() in src/index.ts, which checks
-- PRAGMA table_info(witness_checkpoints) before the ALTER and treats a
-- "duplicate column name" error as done, because SQLite has no
-- ADD COLUMN IF NOT EXISTS. Applied by hand, run the ALTER only if the column
-- is absent.

ALTER TABLE witness_checkpoints ADD COLUMN account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_witness_account ON witness_checkpoints (account_id, received_at);

CREATE TABLE IF NOT EXISTS witness_usage (
  day  TEXT NOT NULL,      -- YYYY-MM-DD, UTC, the day of the receipt's received_at
  pool TEXT NOT NULL,      -- 'anon' or an account_id
  n    INTEGER NOT NULL,   -- new rows stored (or attempted) in that pool that day
  PRIMARY KEY (day, pool)
);
