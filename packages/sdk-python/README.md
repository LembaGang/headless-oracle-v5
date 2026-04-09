# headless-oracle-sdk

Python SDK for [Headless Oracle](https://headlessoracle.com) — Ed25519-signed market-state attestations for 28 global exchanges.

## Install

```bash
pip install headless-oracle-sdk
```

## Quick Start

```python
from headless_oracle import HeadlessOracle

oracle = HeadlessOracle(api_key="ho_free_...")

# Get market status (signed receipt)
receipt = oracle.get_status("XNYS")
if receipt.status != "OPEN":
    print("Market closed, halting execution")

# Verify a receipt (server-side)
result = oracle.verify(receipt)
print(result.valid)  # True

# Offline verification (Ed25519 via PyNaCl)
offline = oracle.verify_offline(receipt)
print(offline["valid"])  # True

# Batch check multiple exchanges
batch = oracle.batch(["XNYS", "XLON", "XHKG"])
if not batch.summary.all_open:
    print("Not all markets open")

# Historical reconstruction
past = oracle.historical("XNYS", "2026-03-09T14:30:00Z")
print(past.computed_status)

# Self-provision an instant key (zero friction)
key = oracle.get_instant_key("my-agent-v1")
print(key.api_key)  # ho_free_...
```

## Auto-Provisioning

If no `api_key` is provided, the SDK auto-provisions a free key on the first 402 response:

```python
oracle = HeadlessOracle()  # no key
receipt = oracle.get_status("XNYS")  # auto-provisions key
```

## Safety Helpers

```python
# Single exchange check
if oracle.is_safe_to_execute("XNYS"):
    # proceed with trade
    pass

# Multi-exchange gate
if oracle.all_open(["XNYS", "XLON", "XHKG"]):
    # all markets open — proceed
    pass
```

## Error Handling

```python
from headless_oracle import HeadlessOracle, OracleError

try:
    receipt = oracle.get_status("XNYS")
except OracleError as e:
    print(e.status)  # 429
    print(e.code)    # 'RATE_LIMITED'
    print(e.body)    # full error response
```

Auto-retries on 429 with exponential backoff (configurable via `max_retries`).

## Context Manager

```python
with HeadlessOracle(api_key="ho_free_...") as oracle:
    receipt = oracle.get_status("XNYS")
```

## All Methods

| Method | Description |
|--------|-------------|
| `get_status(mic)` | Signed receipt (authenticated or demo) |
| `get_demo(mic)` | Public demo receipt (never uses API key) |
| `batch(mics)` | Batch signed receipts |
| `historical(mic, at)` | Historical reconstruction (unsigned) |
| `get_schedule(mic)` | Next open/close times |
| `list_exchanges()` | All 28 exchanges |
| `health()` | Signed liveness probe |
| `briefing()` | Daily market intelligence snapshot |
| `verify(receipt)` | Server-side signature verification |
| `verify_offline(receipt)` | Offline Ed25519 verification (PyNaCl) |
| `get_instant_key(agent_id)` | Self-provision free API key |
| `get_public_key()` | Fetch and cache Ed25519 public key |
| `is_safe_to_execute(mic)` | Returns True only if OPEN |
| `all_open(mics)` | Returns True if all exchanges OPEN |

## Critical Rule

**UNKNOWN and HALTED must be treated as CLOSED.** Halt all execution. This is the fail-closed contract — non-negotiable.

## License

MIT
