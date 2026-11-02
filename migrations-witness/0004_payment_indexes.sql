-- Migration 0004 (chirindo_witness) — payment attestation lookups (witness spec v0.6.1, B-445 T3)
--
-- Partial indexes over paid rows only (payment_json IS NOT NULL), so free and
-- keyed rows cost nothing:
--   idx_witness_payment_id          GET /v1/witness/checkpoints/{id}/payment,
--                                   by payment_json.checkpoint_id
--   idx_witness_payment_settlement  the hourly payment sweep, by settlement and
--                                   received_at
-- A query uses them only if it repeats `payment_json IS NOT NULL`.
--
-- Mirrors ensureWitnessSchema() in src/index.ts, which applies it on first use
-- (CREATE INDEX IF NOT EXISTS, so a repeat is a no-op).

CREATE INDEX IF NOT EXISTS idx_witness_payment_id ON witness_checkpoints (json_extract(payment_json, '$.checkpoint_id')) WHERE payment_json IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_witness_payment_settlement ON witness_checkpoints (json_extract(payment_json, '$.settlement'), received_at) WHERE payment_json IS NOT NULL;
