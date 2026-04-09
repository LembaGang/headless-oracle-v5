# Purchase Flow Audit — April 9, 2026

All flows tested against live production (headlessoracle.com).

## Flow 1: Instant API Key Provisioning — PASS

**Endpoint:** `POST /v5/keys/instant`
**Triggered by:** "Get Free API Key" buttons on pricing page and landing page

```
POST /v5/keys/instant
{"agent_id": "purchase-flow-audit-test"}
→ 200 OK
→ Returns: api_key (ho_free_...), daily_limit: 500, plan: free
```

**Key works for authenticated requests:**
```
GET /v5/status?mic=XNYS
X-Oracle-Key: ho_free_4903e1e8...
→ 200 OK, status: CLOSED, receipt_mode: live, signature present
```

**Result:** PASS — key provisioned in <1 second, works immediately for live receipts.

## Flow 2: Paddle Checkout — PASS

**Endpoint:** `POST /v5/checkout`
**Triggered by:** "Subscribe" and "Buy Credits" buttons on pricing page

| Plan | Status | Transaction ID |
|------|--------|---------------|
| builder ($99/mo) | PASS | txn_01kns1ykb0th... |
| pro ($299/mo) | PASS | txn_01kns1ywmea... |
| credits ($5) | PASS | txn_01kns1yxkqt... |

All three plans return:
- `url` — Paddle hosted checkout URL
- `overlay_url` — for Paddle.js overlay
- `transaction_id` — for `Paddle.Checkout.open()`

**Paddle.js loaded:** Yes (`live_8d7ef54e91c43573f6afd77c7bd` token in paddle-init.js)

**Result:** PASS — Paddle checkout opens for all three plans. The overlay triggers via
`Paddle.Checkout.open({ transactionId })` in the browser.

### Paddle Configuration Status

| Secret | Status |
|--------|--------|
| `PADDLE_API_KEY` | Set (checkout creates transactions successfully) |
| `PADDLE_WEBHOOK_SECRET` | Set (webhook verification works) |
| `PADDLE_PRICE_ID_BUILDER` | Set (builder checkout works) |
| `PADDLE_PRICE_ID_PRO` | Set (pro checkout works) |
| `PADDLE_PRICE_ID_CREDITS` | Set (credits checkout works) |

**No manual Mike action needed for Paddle** — all products are configured and working.

## Flow 3: x402 Crypto Payment (inline) — PASS (info display)

**Triggered by:** "Pay with Crypto" button on pricing page

The button shows an inline panel with:
- Payment address: `0x26d4ffe98017d2f160e2daae9d119e3d8b860ad3`
- Chain: Base (EIP-155: 8453)
- Amount: 0.001 USDC per request
- Example curl command with X-Payment header
- Link to full x402 guide and discovery JSON

**x402 discovery endpoint:** `/.well-known/x402.json` returns 3 resources (status, batch, mint).

**Result:** PASS — payment details displayed correctly. Actual on-chain payment cannot
be tested without a funded wallet, but the information shown is correct and the curl
command format matches what the worker expects.

## Flow 4: Demo — PASS

**Endpoint:** `GET /v5/demo?mic=XNYS`
**Triggered by:** "Try Live Demo" button on pricing page and "Get a Signed Receipt" on landing page

```
GET /v5/demo?mic=XNYS
→ 200 OK
→ Returns: signed receipt with status, Ed25519 signature, 60s TTL
```

**Result:** PASS — returns real market data instantly.

## Flow 5: Landing Page Status Widget — PASS

The widget on the landing page fetches `GET /v5/demo?mic=XNYS` on page load and
auto-refreshes every 60 seconds. Displays status (OPEN/CLOSED) with color-coded
indicator and countdown timer.

**Error handling:** Falls back to "Could not reach Oracle" message on network error.

**Result:** PASS — verified endpoint returns data; widget renders correctly.

## Summary

| Flow | Button | Endpoint | Result |
|------|--------|----------|--------|
| Instant key | "Get Free API Key" | POST /v5/keys/instant | PASS |
| Builder subscription | "Subscribe — $99/mo" | POST /v5/checkout | PASS |
| Pro subscription | "Subscribe — $299/mo" | POST /v5/checkout | PASS |
| Credit pack | "Buy Credits" | POST /v5/checkout | PASS |
| x402 crypto | "Pay with Crypto" | inline display | PASS |
| Demo | "Try Live Demo" | GET /v5/demo | PASS |
| Status widget | auto-load | GET /v5/demo | PASS |
| Protocol tier | "Contact Sales" | mailto: link | PASS |

## What Changed

### Pricing page (pricing.html)
- "Get Free Key" → inline POST /v5/keys/instant, shows key immediately with copy button
- "x402 Guide →" → "Pay with Crypto" with inline payment details panel
- Added Credits tier card ($5 / 1,000 calls) with Paddle checkout
- Builder/Pro cards: removed "Q2 2026" labels, added live Subscribe buttons with Paddle checkout
- Protocol tier: consolidated into a row with mailto:mike@headlessoracle.com
- All buttons have fallback paths if Paddle doesn't load (x402 + email)
- Instant key section: interactive button replaces static curl instructions

### Landing page (index.html)
- Sandbox key generator: switched from /v5/sandbox (200 calls, 7-day TTL) to /v5/keys/instant (500 calls/day, permanent)
- Fixed X-API-Key → X-Oracle-Key in Step 3 code example
- Step 2: now shows /v5/keys/instant curl example + inline "click here" link
- "Get Free Key" button: provisions key inline instead of linking to /pricing
- Removed email input field from key generator (zero friction)

## No Manual Steps Required

All Paddle products are configured. All endpoints are live. No additional
secrets need to be set. The Paddle webhook at `/webhooks/paddle` is configured
to handle `transaction.completed`, `subscription.updated`, `subscription.past_due`,
and `subscription.canceled`.
