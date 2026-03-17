# x402 Micropayments — Headless Oracle

Headless Oracle supports the [x402 protocol](https://x402.org) for per-request USDC micropayments on Base mainnet. This lets autonomous agents pay for API access without a subscription or pre-registered API key.

## When x402 kicks in

Free tier keys (`ho_free_*`) have a **500 requests/day** limit. After the limit is reached:

1. If your account has prepaid credits → one credit is consumed automatically.
2. If `X-Payment` header is present with a valid Base mainnet USDC transaction → request is fulfilled.
3. Otherwise → HTTP 402 with a machine-readable payment instruction.

Paid Paddle subscriptions (Builder/Pro/Protocol) and internal keys are never rate-limited by this gate.

## The 402 Response

When payment is required, the server returns HTTP 402 with:

```json
{
  "error": "PAYMENT_REQUIRED",
  "message": "Free tier exhausted. Pay 0.001 USDC per request via x402 on Base network...",
  "x402": {
    "version": "1",
    "scheme": "exact",
    "network": "base-mainnet",
    "chainId": 8453,
    "amount": "1000",
    "currency": "USDC",
    "decimals": 6,
    "paymentAddress": "0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3",
    "usdcContractAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "memo": "{key_hash}:{date}:{request_id}",
    "maxAge": 300
  },
  "alternatives": {
    "monthly": "https://headlessoracle.com/pricing",
    "free_key": "https://headlessoracle.com/v5/keys/request",
    "prepaid": "https://headlessoracle.com/v5/credits/purchase"
  }
}
```

Response headers also include:
- `X-Payment-Required: true`
- `X-Payment-Scheme: x402`
- `X-Payment-Network: base-mainnet`
- `X-Payment-Chain-ID: 8453`
- `X-Payment-Amount: 0.001 USDC`

## Paying with X-Payment header

1. Send 0.001 USDC (1000 units at 6 decimals) to the `paymentAddress` on Base mainnet.
2. Retry the request with `X-Payment` header containing the transaction details.

```
X-Payment: {"txHash":"0x...","network":"base-mainnet","amount":"1000","paymentAddress":"0x26D4...","memo":""}
```

The server verifies:
- Transaction is on Base mainnet
- USDC Transfer event credits the correct payment address
- Amount ≥ 1000 units (0.001 USDC)
- Transaction is < 300 seconds old
- Transaction hash has not been used before (replay protection)

## Node.js auto-pay agent

```javascript
import { createPublicClient, http, parseUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const ORACLE_KEY = 'ho_free_your_key_here';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY; // Base wallet with USDC

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_ABI = [
  { name: 'transfer', type: 'function', inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' }
  ], outputs: [{ type: 'bool' }] }
];

async function fetchOracleWithAutoPayment(mic = 'XNYS') {
  // First attempt — no payment
  let res = await fetch(`https://headlessoracle.com/v5/status?mic=${mic}`, {
    headers: { 'X-Oracle-Key': ORACLE_KEY }
  });

  if (res.status !== 402) return res.json();

  const body = await res.json();
  const { paymentAddress, amount } = body.x402;

  // Pay on Base mainnet via viem
  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = createPublicClient({ chain: base, transport: http() });
  const { request } = await client.simulateContract({
    address: USDC_CONTRACT,
    abi: USDC_ABI,
    functionName: 'transfer',
    args: [paymentAddress, BigInt(amount)],
    account,
  });
  const walletClient = createWalletClient({ chain: base, transport: http() });
  const txHash = await walletClient.writeContract(request);

  // Wait for confirmation
  await client.waitForTransactionReceipt({ hash: txHash });

  // Retry with X-Payment header
  const payment = JSON.stringify({ txHash, network: 'base-mainnet', amount, paymentAddress, memo: '' });
  res = await fetch(`https://headlessoracle.com/v5/status?mic=${mic}`, {
    headers: { 'X-Oracle-Key': ORACLE_KEY, 'X-Payment': payment }
  });
  return res.json();
}
```

## Python auto-pay agent

```python
import json, time, requests
from web3 import Web3

ORACLE_KEY = "ho_free_your_key_here"
PRIVATE_KEY = os.environ["WALLET_PRIVATE_KEY"]

USDC_CONTRACT = Web3.to_checksum_address("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
USDC_ABI = [{"name": "transfer", "type": "function",
             "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
             "outputs": [{"type": "bool"}]}]

w3 = Web3(Web3.HTTPProvider("https://mainnet.base.org"))
account = w3.eth.account.from_key(PRIVATE_KEY)
usdc = w3.eth.contract(address=USDC_CONTRACT, abi=USDC_ABI)

def fetch_oracle_with_autopay(mic="XNYS"):
    r = requests.get(f"https://headlessoracle.com/v5/status?mic={mic}",
                     headers={"X-Oracle-Key": ORACLE_KEY})
    if r.status_code != 402:
        return r.json()

    x402 = r.json()["x402"]
    payment_address = Web3.to_checksum_address(x402["paymentAddress"])
    amount = int(x402["amount"])  # 1000 = 0.001 USDC

    # Send USDC on Base mainnet
    nonce = w3.eth.get_transaction_count(account.address)
    tx = usdc.functions.transfer(payment_address, amount).build_transaction({
        "from": account.address,
        "nonce": nonce,
        "gas": 100000,
        "gasPrice": w3.eth.gas_price,
        "chainId": 8453,
    })
    signed = w3.eth.account.sign_transaction(tx, PRIVATE_KEY)
    tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction).hex()

    # Wait for inclusion
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
    if receipt["status"] != 1:
        raise RuntimeError("USDC transfer failed")

    # Retry with X-Payment
    payment = json.dumps({"txHash": tx_hash, "network": "base-mainnet",
                          "amount": str(amount), "paymentAddress": x402["paymentAddress"], "memo": ""})
    r2 = requests.get(f"https://headlessoracle.com/v5/status?mic={mic}",
                      headers={"X-Oracle-Key": ORACLE_KEY, "X-Payment": payment})
    return r2.json()
```

## Prepaid Credits

Buy credits in bulk to avoid per-request on-chain transactions.

### Buy 100 credits (0.09 USDC)

```bash
# 1. Pay 90000 USDC units to the payment address on Base mainnet
# 2. POST to credits/purchase with X-Payment header

curl -X POST https://headlessoracle.com/v5/credits/purchase \
  -H "X-Oracle-Key: ho_free_your_key" \
  -H "X-Payment: {\"txHash\":\"0x...\",\"network\":\"base-mainnet\",\"amount\":\"90000\",\"paymentAddress\":\"0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3\",\"memo\":\"\"}"
```

### Buy 1000 credits (0.80 USDC)

Same as above but send 800000 USDC units.

### Check balance

```bash
curl https://headlessoracle.com/v5/credits/balance \
  -H "X-Oracle-Key: ho_free_your_key"
# {"balance": 42, "estimated_requests_remaining": 42, "last_purchased": "2026-03-17T..."}
```

## Discovery

The x402 payment scheme is surfaced on all agent discovery endpoints:

- `GET /.well-known/agent.json` → `payment` object with scheme, network, chain_id, amount
- `GET /v5/health` → `payment_schemes: ["x402"]`
- `GET /v5/compliance` → APTS compliance (unchanged — x402 is additive to the safety model)

## Security Notes

- Transactions expire after 300 seconds — do not reuse old receipts
- Each `txHash` can only be used once (replay protection via ORACLE_TELEMETRY KV, 600s TTL)
- The `paymentAddress` in the 402 response is read from `env.ORACLE_PAYMENT_ADDRESS` — never hardcoded
- Agents should verify the `paymentAddress` matches the expected operator address before paying
