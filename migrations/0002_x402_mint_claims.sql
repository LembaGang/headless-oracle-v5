-- Migration 0002 — x402 mint claims (2026-10-07)
--
-- One Base USDC payment hash mints at most one key. The /v5/x402/mint route
-- INSERTs the lowercase hash into x402_mint_claims after the on-chain check and
-- before a key exists; the PRIMARY KEY makes every other INSERT for that hash a
-- conflict (409). The outcome is a second insert-only row: 'minted' carries the
-- key's sha256 (never the key), 'failed' means the payment was claimed and the
-- key store write failed, and a human must re-issue.
--
-- Insert-only, like the halt archive tables beside it: no UPDATE or DELETE.
-- The worker creates both tables on first use (ensureX402MintClaimSchema in
-- src/index.ts mirrors this file; keep them in step), so applying this
-- migration by hand is not required.

CREATE TABLE IF NOT EXISTS x402_mint_claims (
  tx_hash       TEXT PRIMARY KEY CHECK (tx_hash = lower(tx_hash)),  -- 0x + 64 hex, lowercase
  tier          TEXT NOT NULL,                                       -- builder | pro
  amount_units  TEXT NOT NULL,                                       -- USDC atomic units paid
  payer         TEXT,                                                -- Transfer `from`, lowercase
  claimed_at    TEXT NOT NULL                                        -- ISO 8601
);

CREATE TABLE IF NOT EXISTS x402_mint_outcomes (
  tx_hash       TEXT PRIMARY KEY,
  outcome       TEXT NOT NULL CHECK (outcome IN ('minted', 'failed')),
  tier          TEXT NOT NULL,
  key_hash      TEXT,                                                -- sha256 of the key; NULL when failed
  detail        TEXT,                                                -- why it failed; NULL when minted
  recorded_at   TEXT NOT NULL
);
