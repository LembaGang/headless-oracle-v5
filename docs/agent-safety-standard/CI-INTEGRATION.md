# APTS Compliance Verification in CI/CD

Verify that the oracle your agents depend on passes all 6 APTS checks before merging
or deploying. If the oracle fails its own compliance endpoint, the agent that depends
on it will behave incorrectly at runtime — catching this in CI is strictly better
than catching it in production.

---

## Command-line verification

```bash
# Pass if all checks pass, non-zero exit if any fail
curl -sf https://headlessoracle.com/v5/compliance \
  | jq -e '.overall == "pass"' > /dev/null

echo $?  # 0 = all checks pass, 1 = failure
```

To see which check failed:

```bash
curl -s https://headlessoracle.com/v5/compliance \
  | jq '.checks[] | select(.status != "pass")'
```

---

## GitHub Actions

Add this step to any workflow that depends on Headless Oracle being operational
and conformant. It runs before your tests, not after.

```yaml
# .github/workflows/test.yml (excerpt)

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Verify APTS compliance
        run: |
          response=$(curl -sf https://headlessoracle.com/v5/compliance)
          if [ $? -ne 0 ]; then
            echo "ERROR: Compliance endpoint unreachable"
            exit 1
          fi
          overall=$(echo "$response" | jq -r '.overall')
          if [ "$overall" != "pass" ]; then
            echo "ERROR: APTS compliance check failed"
            echo "$response" | jq '.checks[] | select(.status != "pass")'
            exit 1
          fi
          echo "APTS compliance: pass"

      - name: Run tests
        run: npm test
```

To add it as a reusable composite action:

```yaml
# .github/actions/apts-check/action.yml
name: "APTS Compliance Check"
description: "Verify oracle passes all 6 Agent Pre-Trade Safety Standard checks"
inputs:
  compliance_url:
    description: "Compliance endpoint URL"
    default: "https://headlessoracle.com/v5/compliance"
runs:
  using: "composite"
  steps:
    - name: Check APTS compliance
      shell: bash
      run: |
        response=$(curl -sf ${{ inputs.compliance_url }})
        if [ $? -ne 0 ]; then
          echo "::error::Compliance endpoint unreachable: ${{ inputs.compliance_url }}"
          exit 1
        fi
        overall=$(echo "$response" | jq -r '.overall')
        if [ "$overall" != "pass" ]; then
          echo "::error::APTS compliance failed. Failing checks:"
          echo "$response" | jq -r '.checks[] | select(.status != "pass") | "  - \(.id): \(.status)"'
          exit 1
        fi
        echo "::notice::APTS compliance: all 6 checks pass"
```

Usage:

```yaml
- uses: ./.github/actions/apts-check
```

---

## Python (pytest)

Use this test in your integration test suite. It runs against the live endpoint and
asserts every check individually, so failures point to the specific check that regressed.

```python
# tests/test_apts_compliance.py
import pytest
import requests

COMPLIANCE_URL = "https://headlessoracle.com/v5/compliance"

EXPECTED_CHECKS = [
    "signed_attestation",
    "circuit_breaker",
    "settlement_window",
    "receipt_freshness",
    "signature_verification",
    "fail_closed",
]

@pytest.fixture(scope="module")
def compliance_response():
    resp = requests.get(COMPLIANCE_URL, timeout=10)
    assert resp.status_code == 200, f"Compliance endpoint returned {resp.status_code}"
    return resp.json()

def test_overall_pass(compliance_response):
    assert compliance_response["overall"] == "pass", (
        f"APTS overall status is not 'pass': {compliance_response['overall']}"
    )

def test_all_checks_present(compliance_response):
    check_ids = {c["id"] for c in compliance_response["checks"]}
    for expected in EXPECTED_CHECKS:
        assert expected in check_ids, f"Missing check: {expected}"

@pytest.mark.parametrize("check_id", EXPECTED_CHECKS)
def test_individual_check_passes(compliance_response, check_id):
    checks = {c["id"]: c for c in compliance_response["checks"]}
    assert check_id in checks, f"Check '{check_id}' not in response"
    assert checks[check_id]["status"] == "pass", (
        f"Check '{check_id}' status is '{checks[check_id]['status']}'"
    )

def test_standard_version(compliance_response):
    assert compliance_response.get("version") == "1.0.0"
```

Run:

```bash
pip install pytest requests
pytest tests/test_apts_compliance.py -v
```

---

## Why this matters

An agent that integrates an oracle failing its own compliance checks will behave
incorrectly in exactly the failure modes the standard is designed to prevent:

- If `signed_attestation` fails: the oracle may be returning unsigned responses —
  the agent cannot verify what it is acting on
- If `receipt_freshness` fails: the oracle is issuing receipts without TTLs — the
  agent has no way to detect stale status
- If `signature_verification` fails: the oracle's key endpoint is broken — agents
  cannot independently verify receipts
- If `fail_closed` fails: the oracle may return OPEN on infrastructure error — the
  most dangerous failure mode

CI verification catches regressions in the oracle dependency before they reach
production agents. The compliance endpoint is public and requires no API key.

---

## Pinning to a specific check version

The `version` field in the compliance response identifies the APTS version the oracle
claims to implement. To assert a minimum version in CI:

```bash
version=$(curl -s https://headlessoracle.com/v5/compliance | jq -r '.version')
required="1.0.0"

# Simple string equality for stable major versions
if [ "$version" != "$required" ]; then
  echo "WARNING: Expected APTS $required, got $version"
fi
```
