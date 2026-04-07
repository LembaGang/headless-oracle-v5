# Headless Oracle Market Gate

A GitHub Action that checks whether a stock exchange is open before allowing your workflow to proceed.

## Why

- Don't deploy trading code when markets are closed
- Don't run backtests against live data during trading hours
- Gate your CI/CD pipeline on real market state
- Prevent automated systems from executing during holidays or circuit breakers

## Usage

```yaml
steps:
  - name: Check NYSE is open
    uses: LembaGang/headless-oracle-v5/github-action@main
    with:
      mic: XNYS
      fail_on_closed: true
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `mic` | Yes | — | ISO 10383 Market Identifier Code (e.g. `XNYS`, `XNAS`, `XLON`) |
| `fail_on_closed` | No | `true` | Fail the step if the market is not OPEN |

## Outputs

| Output | Description |
|---|---|
| `status` | Market status: `OPEN`, `CLOSED`, `HALTED`, or `UNKNOWN` |
| `mic` | The MIC code that was checked |
| `checked_at` | ISO 8601 timestamp of the check |

## Supported Exchanges

28 exchanges across Americas, Europe, Middle East, Africa, Asia, and Pacific. Full list: [headlessoracle.com/v5/exchanges](https://headlessoracle.com/v5/exchanges)

## Examples

### Gate deployment on market state

```yaml
name: Deploy Trading Bot
on: push

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check market is open
        uses: LembaGang/headless-oracle-v5/github-action@main
        id: market
        with:
          mic: XNYS

      - name: Deploy
        if: steps.market.outputs.status == 'OPEN'
        run: npm run deploy
```

### Check multiple markets

```yaml
- name: Check NYSE
  uses: LembaGang/headless-oracle-v5/github-action@main
  with:
    mic: XNYS
    fail_on_closed: false
  id: nyse

- name: Check LSE
  uses: LembaGang/headless-oracle-v5/github-action@main
  with:
    mic: XLON
    fail_on_closed: false
  id: lse

- name: Report
  run: |
    echo "NYSE: ${{ steps.nyse.outputs.status }}"
    echo "LSE: ${{ steps.lse.outputs.status }}"
```

### Non-blocking check (log only)

```yaml
- name: Check market state
  uses: LembaGang/headless-oracle-v5/github-action@main
  with:
    mic: XNYS
    fail_on_closed: false
```

## How It Works

Calls the Headless Oracle `/v5/demo` endpoint (free, no API key required) to get the current market state. The response includes an Ed25519-signed receipt with 60-second TTL.

Status meanings:
- **OPEN** — market is in a trading session
- **CLOSED** — market is outside trading hours, on a weekend, or holiday
- **HALTED** — circuit breaker or manual halt active
- **UNKNOWN** — oracle cannot determine state (treat as CLOSED)

## License

MIT
