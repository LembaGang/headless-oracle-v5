# Contributing to Headless Oracle

Last updated: 2026-04-08

## Local Development Setup

### Prerequisites
- Node.js 22+ (see `.nvmrc`)
- npm 10+

### Setup

```bash
git clone https://github.com/LembaGang/headless-oracle-v5.git
cd headless-oracle-v5
npm install
cp .env.example .dev.vars
# Edit .dev.vars with test-only values (see .env.example comments)
```

### Running Tests

```bash
npm test          # Full test suite (725+ tests)
npm run test:smoke  # Smoke tests against live production
```

Tests run inside a real Miniflare Workers runtime via
`@cloudflare/vitest-pool-workers` — not plain Node.js. This catches
Worker-specific API incompatibilities.

### Local Development Server

```bash
npm run dev
```

Opens a local Cloudflare Workers dev server. Requires `.dev.vars` to
be populated with at least the Ed25519 keypair and API keys.

### Deploying

```bash
npm run deploy    # Deploy to Cloudflare Workers
```

Requires `wrangler` CLI authentication (`wrangler login`).

## Commit Message Conventions

Use conventional commit prefixes:

- `feat:` — New feature or endpoint
- `fix:` — Bug fix
- `security:` — Security-related change
- `docs:` — Documentation only
- `ci:` — CI/CD pipeline changes
- `test:` — Test additions or fixes
- `refactor:` — Code change that neither fixes a bug nor adds a feature

Include the test count in parentheses: `feat: add X-Attestation-Mode header (725 tests)`

## Pull Request Process

1. Fork the repository
2. Create a feature branch
3. Make changes and add tests
4. Run `npm test` — all tests must pass
5. Run `npm audit` — no new high/critical vulnerabilities
6. Submit a PR using the template
7. Wait for CI to pass and review

## Code Style

- TypeScript, single file (`src/index.ts`)
- Tabs for indentation (see `.editorconfig`)
- Comments explain WHY, not WHAT
- No premature abstractions
- Validate at system boundaries only

## Architecture

See `CLAUDE.md` and `.claude/rules/02_architecture_map.md` for the
full architecture map with line ranges, function signatures, and data
flow traces.

## Critical Invariants

These must NEVER be violated:

1. UNKNOWN status = CLOSED (fail-closed contract)
2. Receipt TTL = 60 seconds (never extend)
3. Ed25519 signatures verified before acting on receipts
4. No hardcoded UTC offsets (IANA timezone names only)
5. Tests must pass before AND after every change

## License

By contributing, you agree that your contributions will be licensed
under the MIT License.
