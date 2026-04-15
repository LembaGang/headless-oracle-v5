# Awesome-List PR Entries — April 2026

PR-ready entries for three major awesome lists. Each entry matches the host
repository's existing format exactly — do not reformat to a common style when
copying.

---

## 1. wong2/awesome-mcp-servers (~30K stars)

**Target file**: `README.md` → `## Servers` → `### Finance & Fintech`

**Entry format**: `- [name](link) - description.`

**Entry**:

```markdown
- [Headless Oracle](https://headlessoracle.com) - Signed, fail-closed market-state attestations for 28 global exchanges (NYSE, Nasdaq, Tokyo, Shanghai, Korea, London, and 22 more). Ed25519 receipts, 60s TTL, x402 native payment. Pre-trade safety check for autonomous trading agents.
```

**Commit message**:

```
Add Headless Oracle to Finance & Fintech

Headless Oracle is an MCP server returning Ed25519-signed market-state
receipts for 28 global exchanges. Fail-closed (UNKNOWN → CLOSED), 60-second
TTL, x402 native payment. Reference implementation of Multi-Oracle Consensus
spec v1.0.0. MIT licensed.
```

**PR title**: `Add Headless Oracle (Finance & Fintech)`

---

## 2. TensorBlock/awesome-mcp-servers

**Target file**: `README.md` → `## Finance` (or create if missing)

**Entry format**: Table row `| Server | Description | Language | License |`

**Entry**:

```markdown
| [Headless Oracle](https://github.com/LembaGang/headless-oracle-v5) | Signed market-state attestations for 28 global exchanges. Fail-closed, Ed25519, x402 payment, SEC/CFTC tokenized collateral aligned. | TypeScript | MIT |
```

**Existing PR #343** is already open — update the entry to match the April
2026 description above (previous version predates the semantic upgrade).

---

## 3. georgezouq/awesome-ai-in-finance

**Target file**: `README.md` → `## Data Sources` or `## Tools`

**Entry format**: `- [name](link) - description`

**Entry**:

```markdown
- [Headless Oracle](https://headlessoracle.com) - Signed, fail-closed market-state attestations for 28 global exchanges. Pre-trade safety primitive for autonomous AI trading agents. Ed25519 receipts verifiable offline, 60-second TTL, x402 autonomous payment on Base mainnet, MCP and REST interfaces, reference implementation of Multi-Oracle Consensus spec v1.0.0.
```

**Section fit**: `Data Sources` is the best match because the output is a
verifiable data feed. Secondary fit: `Tools` if the maintainer prefers tools
over data sources for MCP servers.

---

## 4. punkpeye/awesome-mcp-servers (if not already merged)

**Target file**: `README.md` → `## Finance & Fintech`

**Entry format**: Match existing list format exactly (bulleted list with icon).

**Entry**:

```markdown
- [LembaGang/headless-oracle-v5](https://github.com/LembaGang/headless-oracle-v5) 📦 🏠 - Signed market-state attestations for 28 global exchanges. Fail-closed, Ed25519, 60s TTL, x402 payment. Pre-trade safety for autonomous trading agents.
```

Icons: 📦 for "published package" (headless-oracle-mcp on npm), 🏠 for "self-hostable / remote server" (https://headlessoracle.com/mcp).

---

## Format discipline

Do NOT:

- Combine entries into a custom format across repos
- Add emoji where the repo doesn't use them
- Pad the description with marketing language
- Include pricing in the entry body (link to `/pricing` if the reviewer asks)
- Reference the product as "the best" or "the leading" — awesome-list maintainers reject those PRs

DO:

- Match the exact markdown style of the nearest existing entry
- Keep descriptions under 200 characters where possible
- Link to the canonical homepage or GitHub repo, not a deep path
- Stage only the README change — no unrelated diffs
