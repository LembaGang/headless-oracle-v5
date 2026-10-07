# `/v5/x402/mint`: a payment is not bound to its payer (open, needs a founder decision)

Found 2026-10-07 by the revenue-path audit; verified against `src/index.ts` at `aec5715`.
Not fixed: every complete fix changes the public payment protocol.

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
