# DataCamp Cold Email — Filip Schouwenaars

**Subject:** 30-day Pro trial for DataCamp learners building trading agents

---

Hi Filip,

I sent you a note a few weeks ago about the DataCamp integration guide we published at headlessoracle.com/docs/integrations/datacamp-workspace. Wanted to follow up with something concrete.

I'd like to offer a 30-day Pro trial for DataCamp learners who are building autonomous trading systems or working through the algo-trading curriculum.

The oracle solves a specific problem that comes up when students move from notebook-based backtesting to live agent systems: market hours verification. Timezone libraries answer the wrong question. The oracle returns a cryptographically signed attestation that a specific exchange is open, with a 60-second TTL. The pattern is:

```python
from headless_oracle import OracleClient

client = OracleClient(api_key="your_key")  # pip install headless-oracle
receipt = client.get_market_status("XNYS")

if receipt["status"] != "OPEN":
    print(f"Market is {receipt['status']} — skipping execution")
    return
```

28 exchanges covered. Free tier available (500 calls/day, no card). Pro adds 200,000 calls/day.

What I'm proposing:
- 30-day Pro trial codes for DataCamp learners who complete an algo-trading or AI agents course
- A co-authored case study or notebook: "Safe autonomous trading with signed market attestations"
- A guest post for DataCamp Community if useful

The integration guide is already live. I just want to make sure the students who find it have a meaningful evaluation path, not a 500 req/day cap that runs out mid-project.

Reply here and we'll find 20 minutes.

Mike
headlessoracle.com
info@bytecraftresults.com
