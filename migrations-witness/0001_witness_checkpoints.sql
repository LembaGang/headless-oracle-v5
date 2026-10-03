-- Migration 0001 (chirindo_witness) — witness checkpoints (witness spec v0.4)
--
-- Append-only. Application code issues INSERT OR IGNORE only, never UPDATE or
-- DELETE. A checkpoint's identity is (kid, session_id, count, last_entry_hash);
-- a repeat submission of the same identity leaves the first row untouched and
-- is answered with its stored receipt. Mirrors ensureWitnessSchema() in
-- src/index.ts, which the test pool uses because it does not apply migrations.

CREATE TABLE IF NOT EXISTS witness_checkpoints (
  kid               TEXT NOT NULL,     -- RFC 7638 thumbprint of the operator's Ed25519 key
  session_id        TEXT NOT NULL,
  count             INTEGER NOT NULL,
  last_entry_hash   TEXT NOT NULL,     -- sha256:<64 hex>
  checkpoint_jcs    TEXT NOT NULL,     -- JCS of the full signed checkpoint, sig included
  checkpoint_sha256 TEXT NOT NULL,     -- sha256:<hex> of checkpoint_jcs
  public_key_x      TEXT NOT NULL,     -- the JWK x the checkpoint verified against
  received_at       TEXT NOT NULL,     -- ISO 8601, as signed into the receipt
  fork              TEXT NOT NULL,     -- "true" | "false", as signed into the receipt
  receipt_json      TEXT NOT NULL,     -- the exact signed receipt returned
  created_at        TEXT NOT NULL      -- ISO 8601 of INSERT (server clock)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_witness_identity      ON witness_checkpoints (kid, session_id, count, last_entry_hash);
CREATE INDEX        IF NOT EXISTS idx_witness_session_count ON witness_checkpoints (kid, session_id, count);
-- The daily cap counts today's rows by received_at.
CREATE INDEX        IF NOT EXISTS idx_witness_received_at   ON witness_checkpoints (received_at);
