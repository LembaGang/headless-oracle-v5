# Headless Oracle

Ed25519-signed market-state attestations for 28 global exchanges.

## What It Does

Autonomous trading agents need to know if an exchange is open before executing trades. Headless Oracle answers that question with a cryptographically signed receipt that any agent can verify independently — no trust in the operator required. UNKNOWN states are always treated as CLOSED (fail-closed).

## Quick Start

```bash
# MCP (Claude Desktop, Cursor, any MCP client)
npx headless-oracle-mcp

# REST API — demo receipt (no auth required)
curl https://headlessoracle.com/v5/demo?mic=XNYS

# Instant sandbox key (200 calls, 7 days, no signup)
curl https://headlessoracle.com/v5/sandbox
```

## Architecture

Single TypeScript Cloudflare Worker (~14,000 lines). Ed25519 signing via `@noble/ed25519`. Three KV namespaces (overrides, API keys, telemetry). Two Durable Objects (webhooks, SSE streams). Deployed to 300+ edge locations globally.

4-tier fail-closed: KV override check -> schedule engine -> UNKNOWN fallback -> unsigned critical failure.

See [docs/architecture/overview.md](docs/architecture/overview.md) for the full architecture.

## API

5 MCP tools and 25+ REST endpoints. Full references:
- [REST API Reference](docs/api/rest-reference.md)
- [MCP Reference](docs/api/mcp-reference.md)
- [OpenAPI 3.1 Spec](https://headlessoracle.com/openapi.json)

## Exchanges

23 traditional markets (XNYS, XNAS, XLON, XJPX, XPAR, XHKG, XSES, XASX, XBOM, XNSE, XSHG, XSHE, XKRX, XJSE, XBSP, XSWX, XMIL, XIST, XSAU, XDFM, XNZE, XHEL, XSTO) plus 5 extended (XCBT, XNYM, XCBO, XCOI, XBIN). DST handled automatically via IANA timezone names. Lunch breaks, half-days, and holidays for 2026-2027.

## Testing

```bash
npm test              # 725+ unit/integration tests
npm run test:smoke    # 11 live production smoke tests
```

## Security

Ed25519 signatures on every response. 60-second receipt TTL. Fail-closed architecture (UNKNOWN = CLOSED). Security headers on all responses (HSTS, CSP, X-Content-Type-Options, X-Frame-Options).

See [SECURITY.md](SECURITY.md) for the responsible disclosure policy.

## Documentation

Full documentation organized by audience:

- **Engineers**: [Architecture](docs/architecture/overview.md), [API Reference](docs/api/), [ADRs](docs/architecture/adr/)
- **Operations**: [Deployment](docs/operations/deployment.md), [Monitoring](docs/operations/monitoring.md), [SLA](docs/operations/sla.md)
- **Legal**: [Terms of Service](docs/legal/terms-of-service.md), [Privacy Policy](docs/legal/privacy-policy.md), [IP Ownership](docs/legal/ip-ownership.md)
- **Business**: [Pricing](docs/business/pricing-strategy.md), [Competitive Analysis](docs/business/competitive-analysis.md)

See [docs/README.md](docs/README.md) for the full index.

## License

MIT — see [LICENSE](LICENSE)
