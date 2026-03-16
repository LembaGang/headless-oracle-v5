# SMA Protocol v1.0 — FAQ

---

**Q: Why is SMA vendor-neutral? Couldn't Headless Oracle just define its own format?**

A: A vendor-specific format creates a trust dependency on the vendor. If the protocol is
controlled by one operator, consumers are trusting that operator's continued goodwill and
uptime — not a cryptographic proof. SMA is defined as an open standard so that any operator
can implement it, consumers can verify receipts from any conformant operator, and the
ecosystem is not dependent on a single point of failure. Headless Oracle is the reference
implementation, not the authority.

---

**Q: Why Ed25519 and not RSA or ECDSA?**

A: Three reasons. First, Ed25519 signatures are deterministic — identical inputs always
produce identical signatures, which eliminates an entire class of implementation bugs.
ECDSA without RFC 6979 is non-deterministic and has caused real-world key leaks. Second,
Ed25519 keys are 32 bytes and signatures are 64 bytes — small enough to embed in any
payload without bloat. Third, Ed25519 composes cleanly into threshold signing schemes
(e.g. 2-of-3 multi-party attestation) when single-operator trust is no longer sufficient
at scale. RSA does not compose cleanly into these schemes.

---

**Q: Why sort payload keys alphabetically? Why not just use insertion order?**

A: JavaScript object key order is insertion-order-dependent since ES2015, but other
languages (Python dicts pre-3.7, many JSON parsers) do not guarantee insertion order.
Without a canonical form, any field reorder in a future refactor silently breaks all
existing verifiers. Alphabetical sort is simple, deterministic, and implementable in
any language with a standard sort. The canonical form is documented in SPEC.md Section 4
so any consumer can independently verify without coordinating with the oracle operator.

---

**Q: Why a 60-second TTL? That seems short.**

A: The TTL is intentionally short. Market open/close transitions happen at known times, but
the exact second matters — a cached `OPEN` receipt from 59 seconds ago could lead an agent
to submit an order after close. A 60-second window forces re-fetch on every agent decision
cycle, which is the correct behavior. Agents that find this too expensive should cache the
key (not the receipt) and use the `publicKey` option in the consumer SDK to skip the key
registry fetch.

---

**Q: What does `UNKNOWN` mean and why does it exist?**

A: `UNKNOWN` means the oracle cannot determine market state with sufficient confidence to
return `OPEN` or `CLOSED`. This happens when: holiday data is missing for the current year,
schedule computation throws an error, or the oracle's own infrastructure is degraded.

`UNKNOWN` exists because the alternative — returning `OPEN` or `CLOSED` when state is
indeterminate — is worse. An agent that receives `UNKNOWN` and treats it as `CLOSED` loses
at most one opportunity. An agent that receives a silently wrong `OPEN` may execute a trade
into a closed market.

Consumers MUST treat `UNKNOWN` as `CLOSED`. This requirement is non-negotiable under SMA.

---

**Q: Can I run my own SMA-conformant oracle?**

A: Yes. SMA is an open protocol, Apache 2.0 licensed. You need: an Ed25519 keypair, a
schedule engine for your target exchanges, a signing implementation that produces the
canonical payload per SPEC.md Section 4, and a `/.well-known/oracle-keys.json` endpoint.
See CONFORMANCE.md for the full operator checklist.

---

**Q: What is `receipt_mode` and why is it a signed field?**

A: `receipt_mode` is `"demo"` or `"live"`. Demo receipts are served from public,
unauthenticated endpoints intended for integration testing. Live receipts are served from
production, authenticated endpoints and are suitable for agent decisions.

The field is part of the signed canonical payload — not a header or metadata — because it
must be tamper-proof. If it were unsigned, an adversary could strip the field or flip its
value between the oracle and the consumer. A consumer checking `receipt_mode` on a signed
receipt knows the oracle itself attested to the mode.

---

**Q: How does key rotation work?**

A: The oracle operator sets `valid_until` on the current key before deploying the
replacement. Consumers fetching `/.well-known/oracle-keys.json` will see the expiry
timestamp and can prepare. On the rotation date, the operator deploys a new keypair and
publishes the new key at `/.well-known/oracle-keys.json`. Receipts signed with the old key
will be invalid after the rotation; consumers should re-fetch the key registry on any
signature verification failure rather than hard-failing.

The SMA protocol recommends at least 24 hours between `valid_until` announcement and the
actual rotation. Operators MUST NOT rotate keys without first publishing `valid_until`.

---

**Q: What is the `issuer` field for?**

A: `issuer` is the FQDN of the oracle operator (e.g. `"headlessoracle.com"`). It makes
receipts self-describing: a consumer receiving a receipt it has never seen before can
resolve `{issuer}/.well-known/oracle-keys.json` to find the public key without any prior
configuration. This is essential for agent-to-agent receipt passing — an agent that
receives a forwarded receipt from another agent can verify it independently without knowing
anything about the source oracle in advance.

---

**Q: How do I verify an SMA receipt in JavaScript and Python?**

JavaScript (Node.js 18+ / Cloudflare Workers / browser):

```js
import { verify } from '@headlessoracle/verify';

const receipt = await fetch('https://headlessoracle.com/v5/demo?mic=XNYS').then(r => r.json());
const result = await verify(receipt);

if (!result.valid) throw new Error(`Invalid receipt: ${result.reason}`);
if (receipt.status !== 'OPEN') return; // market not open — do not trade
```

Python:

```python
from headless_oracle import verify
import httpx

receipt = httpx.get("https://headlessoracle.com/v5/demo?mic=XNYS").json()
result = verify(receipt)

if not result.valid:
    raise ValueError(f"Invalid receipt: {result.reason}")
if receipt["status"] != "OPEN":
    return  # market not open — do not trade
```

Both SDKs implement the full consumer checklist from CONFORMANCE.md: signature verification,
TTL check, and machine-readable failure reasons.
