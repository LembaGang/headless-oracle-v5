# `/v5/x402/mint`: binding a payment to its payer (B implemented 2026-10-07; A implemented 2026-10-08)

Found 2026-10-07 by the revenue-path audit; verified against `src/index.ts` at `aec5715`.

**Status (2026-10-08).** Both fixes are in source (A not yet deployed). Option B (the atomic D1 claim, 2026-10-07)
closes failures B and C below. Option A (payer binding, 2026-10-08, see "What A
shipped" at the end) closes failure A: a mint now needs a signature from the address
that sent the payment, checked before the hash is claimed. The sections "What the code
does" and "Three failures" describe the code before B, as found.

## What the code does

`POST /v5/x402/mint` mints a persistent `ho_live_` key (Builder or Pro) when the caller
presents the hash of a Base USDC transfer of at least the plan price to the payment
address. `verifyX402MintPayment` (`src/index.ts` ~4334):

1. reads `x402_used_tx:<hash>` from `ORACLE_TELEMETRY` and refuses if present;
2. makes two RPC calls (receipt, block) and checks amount, recipient and age (≤ 600s);
3. writes `x402_used_tx:<hash>` with `.catch(() => {})`;
4. returns the payer address `from`, which the route records but does not check.

The route (~14763) then writes the key to `ORACLE_API_KEYS` and returns it.

## Three failures

| | Scenario | Outcome |
|---|---|---|
| A. Front-running | Anyone watching USDC transfers to the public payment address POSTs a fresh ≥ $99 transfer hash before the payer does (600s window). | The watcher gets the Builder key; the payer gets 409 `TRANSACTION_ALREADY_USED`. Nothing in the request proves the caller sent the payment. |
| B. Double mint | N concurrent POSTs with one hash, or retries landing in different Cloudflare locations (KV is eventually consistent), or the step-3 write failing silently. | N keys for one payment. Step 3 is check-then-set across two RPC round trips, and its failure is swallowed (fail-open). |
| C. Paid, no key | Step 3 succeeds, then the `ORACLE_API_KEYS.put` throws. | The caller gets 500; every retry gets 409. The payment is consumed and no alert fires (`recordX402MintEvent` is never reached). |

Exposure today: low traffic, four lifetime x402 settlements, none of them a mint. A is
the one an attacker can drive deliberately; it costs them nothing but watching the chain.

## Options

**A — bind the payment to the payer (protocol change, the real fix).** The caller signs
`mint:<txHash>:<nonce>` with the key of the `from` address (EIP-191 `personal_sign`);
the worker recovers the signer and requires it to equal the Transfer's `from`. A nonce
from a new `GET /v5/x402/mint/nonce` (KV, 10-minute TTL, single use) stops replay of the
signature. Cost: one secp256k1 recover in the worker (`@noble/curves`, already a
transitive dependency in the ecosystem; check the bundle), one new endpoint, a breaking
change for any existing mint client (there are none on record), and docs in `/llms.txt`,
openapi and `/.well-known/x402.json`. An x402 v2 facilitator settlement already carries
the payer's signed authorization (EIP-3009); if mint moves to the facilitator path,
binding comes from the protocol instead of a custom signature.

**B — make the claim atomic (fixes B and C, not A).** Claim the hash in a store with a
uniqueness guarantee before minting: a D1 `INSERT` into a table with a UNIQUE
`tx_hash` (D1 is already bound for the witness) or a Durable Object keyed by hash. A
failed claim refuses (fail closed). Order: claim → mint → mark claim `minted`; if the
mint write fails, mark the claim `failed` and alert, so the founder can re-issue rather
than the payment vanishing. No protocol change.

**C — interim, smallest:** stop swallowing the step-3 write failure (refuse instead),
and log + alert on scenario C. Narrows B and C; does nothing for A.

## Recommendation

B now (no client-visible change, closes the double-mint and paid-no-key holes), A before
mint is promoted anywhere an agent might use it at volume. Until A ships, the honest
position is that `/v5/x402/mint` is first-come-first-served on a public transfer.

## What B shipped (2026-10-07)

- **Store.** Two insert-only tables in the existing `HALT_ARCHIVE` D1 database
  (`halt_archive`): `x402_mint_claims` (PRIMARY KEY `tx_hash`, lowercase enforced by a
  CHECK) and `x402_mint_outcomes` (PRIMARY KEY `tx_hash`, `outcome` `minted` | `failed`,
  `key_hash`, never the key). The worker creates them on first use
  (`ensureX402MintClaimSchema`, mirrored by `migrations/0002_x402_mint_claims.sql`); no
  new Cloudflare resource and no manual migration. `halt_archive` rather than
  `chirindo_witness` because nothing an anonymous caller sends writes to it, so a
  witness flood cannot stop a paid mint.
- **Order.** Verify on chain (unchanged: amount, recipient, 600s age) → `INSERT … ON
  CONFLICT (tx_hash) DO NOTHING`; zero rows changed is **409 `CONFLICT`** (body now also
  carries `claim_status`) → write the KV mark `x402_used_tx:` → mint and store the key →
  insert outcome `minted` with the key hash.
- **Claim store down** → **503 `SERVICE_UNAVAILABLE`**, `detail:
  MINT_CLAIM_STORE_UNAVAILABLE`, `Retry-After: 30`, no key, and no KV mark, so the
  retry can still mint. Log `X402_MINT_CLAIM_UNAVAILABLE`. `HALT_ARCHIVE` or
  `ORACLE_API_KEYS` unbound → 503 before the payment is read.
- **Key store write fails after the claim** → outcome `failed`, log
  `X402_MINT_KEY_STORE_FAILED`, and a `paddle_revenue_event:` row with tier
  `x402_mint_failed` and `txn_id` = the hash (the B-144 alert path: `/v5/revenue-pulse`
  → `health-check.yml` opens a GitHub issue per txn_id). The caller gets **500
  `MINT_KEY_NOT_STORED`** with `payment_received: true`, `tx_hash` and `contact`; a retry
  gets 409 with `claim_status: failed` and the same contact.
- **The KV mark** `x402_used_tx:` is still written (after the claim) and still read as
  an early refusal, but it no longer decides whether a second key is minted.
- **Not covered.** A request that dies between the claim and its outcome (isolate
  killed mid-mint) leaves a claim with no outcome: the hash is spent, no key, and no
  alert fires. A sweep of claims without an outcome older than a few minutes into the
  same alert path would close it; not built.

## What A shipped (2026-10-08)

Founder ruling: option A, without the nonce endpoint. The tx hash is already single-use
in D1 and the signature travels over TLS, so a nonce buys nothing: a replayed signature
can only re-present a hash that is already claimed.

- **Request.** The body gains `signature`: an EIP-191 `personal_sign` signature by the
  address that sent the USDC Transfer, over the exact ASCII message

  ```
  headlessoracle.com x402 mint <tx_hash>
  ```

  where `<tx_hash>` is the 0x-prefixed 32-byte hash in lowercase (the worker lowercases
  whatever case was submitted). The message is built by one function,
  `x402MintSigningMessage()` in `src/index.ts`, used by the route, the served docs and
  the tests. Encoding: 65 bytes of 0x-prefixed hex, `r || s || v`, `v` = 27/28 or 0/1.
- **Check.** The worker hashes `"\x19Ethereum Signed Message:\n" + len + message` with
  keccak-256, recovers the secp256k1 public key (`@noble/curves`), derives the address
  (last 20 bytes of keccak-256 of the uncompressed key) and requires it to equal the
  Transfer's `from` that `verifyX402MintPayment` already extracts (case-insensitive).
- **Order (load-bearing).** Parse body → signature present and recoverable → on-chain
  verify (amount, recipient, age; returns `from`) → signer equals `from` → D1 claim →
  mint. A missing, malformed or wrong signature never writes a claim row, so it cannot
  spend a legitimate payer's claim. Every B behaviour stands: claim store down → 503,
  key store failure after the claim → 500 `MINT_KEY_NOT_STORED` + alert, reused hash →
  409.
- **Errors.** Missing → 400 `PAYER_SIGNATURE_REQUIRED`. Not 65-byte hex, bad `v`, or no
  point recovers → 400 `INVALID_PAYER_SIGNATURE`. Recovered address ≠ Transfer sender →
  403 `PAYER_MISMATCH` with `recovered_address` and `payer_address`. Each carries
  `message_to_sign` and `signature_format`, so an agent can recover without a follow-up
  question. A mismatch logs `X402_MINT_PAYER_MISMATCH`.
- **Limitation: EOA only.** A smart-contract wallet (ERC-1271) cannot `personal_sign`
  with a recoverable key, so a payment from one cannot mint. The 403 says so. Supporting
  it would need an `isValidSignature` RPC call against the payer contract; not built.
- **Breaking change.** Mint clients must now send `signature`; there is no unsigned
  grace path (fail closed). No mint client is on record (four lifetime x402
  settlements, none a mint).
- **Served docs.** openapi `/v5/x402/mint` (request schema, 400/402/403), `/.well-known/x402.json`
  (input schema), `/llms-full.txt` Path D and its route table, `/auth.md` §4,
  `/.well-known/agent.json` (`mint_payer_signature`). `/llms.txt`, `/SKILL.md` and
  `/AGENTS.md` do not document the mint. Not changed, on purpose: the 402 builders
  (`build402Payload`, `buildAgentActions`) still point at the mint with a body hint
  that omits `signature`; a client following it gets the 400 that carries the message.
