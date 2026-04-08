<!-- DRAFT — Not yet reviewed by legal counsel. Do not publish to
production until reviewed. Last updated: 2026-04-08 -->

# Headless Oracle — Intellectual Property Ownership

**Last Updated**: 2026-04-08

## Ownership

All intellectual property rights in the Headless Oracle service, including but not limited to source code, architecture, signing infrastructure, receipt format, API design, and documentation, are owned by Michael Msebenzi / LembaGang.

## Published Specifications

The following open specifications are authored by Michael Msebenzi and published under the Apache License 2.0:

| Specification | Repository | License |
|---|---|---|
| SMA Protocol (Signed Market Attestation) | github.com/LembaGang/sma-protocol | Apache 2.0 |
| APTS (Agent Pre-Trade Safety Standard) | github.com/LembaGang/agent-pretrade-safety-standard | Apache 2.0 |
| MPAS (Multi-Party Attestation Spec) | github.com/LembaGang/mpas-spec | Apache 2.0 |

## Published Packages

| Package | Registry | License |
|---|---|---|
| `headless-oracle-mcp` | npm | MIT |
| `@headlessoracle/verify` | npm | MIT |
| `headless-oracle-setup` | npm | MIT |
| `headless-oracle` | PyPI | MIT |
| `headless-oracle-langchain` | PyPI | MIT |
| `headless-oracle-crewai` | PyPI | MIT |
| `headless-oracle-strands` | PyPI | MIT |
| `headless-oracle-go` | GitHub | MIT |

## Domain

- **headlessoracle.com** — registered via Cloudflare, expires February 2027
- DNS managed via Cloudflare

## Codebase Authorship

No third-party contractors have contributed to the codebase. All code was written by the founder (Michael Msebenzi) with AI-assisted tooling (Claude Code, Cursor). AI-generated code is not subject to independent copyright claims under current law (consistent with US Copyright Office guidance and emerging international consensus as of 2026).

The repository is a single-author codebase with full git history from initial commit, demonstrating sole authorship.

## Trademark Status

"HEADLESS ORACLE" — not yet registered as a trademark. Registration pending. Common law trademark rights apply through continuous commercial use since January 2026.

## Open Source License

The public repository is licensed under the MIT License. See [LICENSE](/LICENSE).

The MIT license grants users the right to use, copy, modify, and distribute the software. It does not grant rights to the "Headless Oracle" name, branding, or the production signing keys.

## Third-Party Dependencies (Production)

| Package | License | Purpose |
|---|---|---|
| `@noble/ed25519` | MIT | Ed25519 signing |
| `@noble/hashes` | MIT | SHA-256, SHA-512 |
| `@supabase/supabase-js` | MIT | Key management |

All production dependencies are MIT or 0BSD licensed. No copyleft licenses in the production dependency tree. Full audit: [docs/security/dependency-audit.md](../security/dependency-audit.md).

## Contact

IP and licensing inquiries: legal@headlessoracle.com
