-- Migration 0001 — Signed Halt Archive
--
-- Append-only D1 schema. Application code MUST NOT issue UPDATE or DELETE
-- against either table after a row is committed. The capture pipeline only
-- INSERTs; the daily digest is INSERT OR IGNORE so a retry of the same date
-- is a no-op rather than a tamper.
--
-- Claim ceiling: every payload_json in halt_events is "observed source S
-- reported X at time T" — never ground truth. The schema does not encode
-- ground truth anywhere; consumers verify the signature against the
-- canonical payload and read the observation phrase.

CREATE TABLE IF NOT EXISTS halt_events (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,             -- nyse | nasdaq | ho_session | gap
  source_mode     TEXT NOT NULL,             -- LIVE | BACKFILL  (never mixed silently)
  mic             TEXT NOT NULL,             -- empty string when not applicable
  event_type      TEXT NOT NULL,             -- feed_snapshot | session_transition | gap
  observed_at     TEXT NOT NULL,             -- ISO 8601 — when the source claim was made
  captured_at     TEXT NOT NULL,             -- ISO 8601 — when we wrote it
  observation     TEXT NOT NULL,             -- the observed-source phrase, signed
  body_sha256     TEXT NOT NULL,             -- sha256 of raw bytes (R2 anchor); empty if none
  r2_key          TEXT NOT NULL,             -- pointer into HALT_ARCHIVE_RAW; empty if none
  payload_json    TEXT NOT NULL,             -- the canonical JSON that was signed
  signature       TEXT NOT NULL,             -- Ed25519 signature, hex
  key_id          TEXT NOT NULL,             -- public_key_id used for signing
  created_at      TEXT NOT NULL              -- ISO 8601 of INSERT (server clock)
);

CREATE INDEX IF NOT EXISTS idx_halt_events_observed_at ON halt_events (observed_at);
CREATE INDEX IF NOT EXISTS idx_halt_events_source      ON halt_events (source);
CREATE INDEX IF NOT EXISTS idx_halt_events_mic         ON halt_events (mic);
CREATE INDEX IF NOT EXISTS idx_halt_events_source_mode ON halt_events (source_mode);
CREATE INDEX IF NOT EXISTS idx_halt_events_event_type  ON halt_events (event_type);

-- One signed digest row per UTC day. previous_day_merkle_root chains the days
-- so any single digest is independently verifiable against its neighbour.
CREATE TABLE IF NOT EXISTS halt_archive_digest (
  date                      TEXT PRIMARY KEY,    -- YYYY-MM-DD UTC
  event_count               INTEGER NOT NULL,
  merkle_root               TEXT NOT NULL,       -- SHA-256 over signatures of the day, sorted by (observed_at, id)
  previous_day_merkle_root  TEXT NOT NULL,       -- empty string for the first day in the chain
  chain_length              INTEGER NOT NULL,
  source_modes              TEXT NOT NULL,       -- e.g. "LIVE" or "BACKFILL" or "BACKFILL,LIVE"
  payload_json              TEXT NOT NULL,       -- signed canonical
  signature                 TEXT NOT NULL,
  key_id                    TEXT NOT NULL,
  created_at                TEXT NOT NULL
);
