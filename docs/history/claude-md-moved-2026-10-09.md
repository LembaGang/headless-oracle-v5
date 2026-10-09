# CLAUDE.md sections moved on 2026-10-09

Moved verbatim from `CLAUDE.md` "Current State" because the always-loaded memory total
was at 147,560 of its 150,000-character limit before the H6 entry. Nothing below was
edited; the pointer left behind keeps the rules that still stand.

- **2026-10-04 (later): the key on screen after payment.** Deployed as `63974cb5…`
  (13:13:02Z, from `afc1c80`): H2 `a0f3c75`, H2b `afc1c80`. Suite **1535 → 1589**.
  - Buyers of builder, pro, protocol, credits, custody_90d and custody_1y see their key
    on the pricing page after payment (web W2 `67865d3` + W2b `21036c9`, deployed after
    this worker). `/v5/checkout` returns `claim_token`; Paddle carries
    `custom_data.ho_claim` = sha256(token); the mint seals the key (AES-GCM, HKDF of
    `PADDLE_WEBHOOK_SECRET`) into `claim_ready:<h>` (24h); `POST /v5/claim` answers
    pending, ready, or 410 after 24h. ORACLE_API_KEYS: `claim:` (7d), `claim_ready:`,
    `paddle_txn:` (credits dedupe, 30d). ORACLE_TELEMETRY: `claim_filled:`/`claim_seen:` (7d).
  - **Email to buyers is failing**: the worker's `RESEND_API_KEY` belongs to the Resend
    team where headlessoracle.com is not verified. Until that key is replaced, the claim
    page is the delivery, and the alarm is a GitHub issue `Key not collected: <txn_id>
    (<plan>)` opened by the health check from `/v5/revenue-pulse` `paddle.unclaimed_keys`
    (filled over 2h ago, never fetched).
  - **Do not rotate `PADDLE_WEBHOOK_SECRET`** while any `claim_ready` is under 24h old:
    the seal is derived from it and those keys become unreadable.
  - Log events `CLAIM_SETUP_FAILED`, `CLAIM_FILL_FAILED`, `CLAIM_FILLED_RECORD_FAILED`,
    `CLAIM_UNSEAL_FAILED`, `CLAIM_SEEN_WRITE_FAILED`, `CLAIM_READ_FAILED`,
    `CLAIM_RATE_LIMITER_FAILED` (the `/v5/claim` limit on `WITNESS_GET_RL` fails open),
    `CREDITS_DEDUPE_READ_FAILED`, `CREDITS_DEDUPE_WRITE_FAILED`.
  - **Open**: Paddle echoing `custom_data` into `transaction.completed` is unverified
    against a real payload; no script recovers an uncollected key for the founder;
    `monitors.md`, `04_telemetry_guide.md` not updated for the claim pipeline.
- **2026-10-04: Witness and paid-plan delivery live**, deployed as `32f367e6…`
  (08:02:06Z, from `3d4b723`). W1 `c43e17a`, W2 `96bbaee`, W3 `afa5338` (first deployed
  3 Oct as `28f81845…`), H1a `ede783b`, H1b `826fa59` + `3d4b723`. Suite **1432 → 1535**.
  - **Witness** on `api.headlessoracle.com/v1/witness/*`, spec `witness-spec/0.5`. The
    apex route `headlessoracle.com/v1/witness/*` is NOT added (B-115). Storage is D1
    `chirindo_witness`; `ensureWitnessSchema` applies `migrations-witness/0002` on first
    use. Rate limits `WITNESS_POST_RL`/`WITNESS_GET_RL` 60/min, `WITNESS_ACCT_RL` 600/min,
    per Cloudflare location, and **fail open** (the only fail-open path in the witness;
    the spec says so; daily cap and store stay fail-closed). The limits are constants
    in source mirrored in `wrangler.toml`: change both. `status_code:`/referrer KV
    counters still write on every witness response.
  - **Evidence plans.** `custody_90d` = `evidence_starter` (1,000 new checkpoints/UTC
    day), `custody_1y` = `evidence` (3,000/day). A purchase delivers a Witness key
    (`Authorization: Bearer ho_live_…` on POST checkpoints); `checkApiKey` maps them to
    `free` for `/v5/*`. Every paid plan delivers its key; `subscription.activated` never
    mints. Provisioning is KV-first (`paddle_sub:` in ORACLE_API_KEYS, no TTL) with
    Supabase best effort. Fail-closed calls ratified: status event with a KV miss AND a
    failed Supabase lookup → 503 (D2); lost `last_event_at` write → 503. New log events
    `PADDLE_SUPABASE_WRITE_FAILED`, `PADDLE_KV_WRITE_FAILED`, `PADDLE_DEDUPE_UNAVAILABLE`,
    `PADDLE_SUB_UNKNOWN`, `PADDLE_ACTIVATED_NO_MINT`, `PADDLE_EVENT_OUT_OF_ORDER`,
    `SUPABASE_KEEPALIVE`; revenue tier `evidence:<plan>`.
  - **Supabase** `sahqfuyneoeqczupmysu` was paused 3 Oct and restored; `supabaseKeepalive`
    runs in the 09:00 cron. Production `api_keys` has a UNIQUE index on
    `stripe_subscription_id` (applied 4 Oct, in no repo schema file).
  - **Account on Workers FREE**: D1 500 MB, 100k rows written/day account-wide.
  - **Open**: Paddle `origin` values unverified against a real payload; credits mint
    has no founder line (D3; dedupe added by H2b); `/llms.txt`, `/AGENTS.md`, web `/pricing` and
    the Paddle product names not checked against Witness v0.5; no production POST to
    the witness has succeeded yet.
