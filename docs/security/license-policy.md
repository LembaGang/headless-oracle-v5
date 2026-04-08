# License Policy

Last updated: 2026-04-08

Headless Oracle uses only permissive open-source licenses in production
dependencies.

## Approved Licenses

- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC
- 0BSD
- CC0-1.0
- Unlicense

## Prohibited Licenses

- GPL-2.0
- GPL-3.0
- AGPL-3.0
- SSPL-1.0
- EUPL-1.1

Any new dependency must be checked before merging. The CI pipeline
enforces this via `license-checker --production --failOn` in the
`ci.yml` workflow.

## Current Status

All 3 production dependencies (and their transitive deps) are MIT or
0BSD. Zero copyleft licenses in the production dependency tree.

| Package | License |
|---------|---------|
| @noble/ed25519 | MIT |
| @noble/hashes | MIT |
| @supabase/supabase-js | MIT |
| tslib | 0BSD |
| ws | MIT |
| iceberg-js | MIT |

## Project License

Headless Oracle is licensed under the MIT License.
Copyright (c) 2026 Michael Msebenzi / LembaGang.
