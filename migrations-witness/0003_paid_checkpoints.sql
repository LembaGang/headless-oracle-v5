-- Migration 0003 (chirindo_witness) — paid checkpoints (witness spec v0.6, B-445 T2)
--
-- A checkpoint paid by x402 under Witness-Spec: 0.6 stores its payment as JSON:
-- { resource, amount_units, amount_usdc, network, transaction, path,
--   settlement, settlement_error? }. Free and keyed rows leave it NULL. It is
-- not part of the signed receipt. It is the one column the application writes
-- a second time: from settlement "pending" to "settled" or "failed", after the
-- row is stored and the facilitator has answered.
--
-- Mirrors ensureWitnessSchema() in src/index.ts, which checks
-- PRAGMA table_info(witness_checkpoints) before the ALTER and treats a
-- "duplicate column name" error as done. Applied by hand, run the ALTER only if
-- the column is absent.

ALTER TABLE witness_checkpoints ADD COLUMN payment_json TEXT;
