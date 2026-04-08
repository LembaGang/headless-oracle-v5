# ADR-001: Cloudflare Workers Single-File Monolith

## Status
Accepted

## Date
2026-01-15

## Context
We needed a runtime for a cryptographic signing service that runs at
the edge with sub-50ms latency globally. The service must handle
Ed25519 signing, KV lookups, and external API calls in a single
request cycle. We evaluated traditional servers (EC2, GCP Cloud Run),
serverless functions (AWS Lambda, Vercel), and edge runtimes
(Cloudflare Workers, Deno Deploy).

## Decision
Deploy as a single TypeScript file on Cloudflare Workers. No origin
server. No container orchestration. No microservices decomposition.

The entire application — routing, signing, billing, MCP, telemetry,
and schedule engine — lives in `src/index.ts` (~14,000 lines).

## Consequences

**Benefits:**
- Zero cold start (V8 isolates, not containers)
- Global edge deployment — requests served from nearest PoP
- Built-in KV storage for circuit breakers and API key cache
- Durable Objects for stateful webhooks and SSE streams
- $15.50/month infrastructure cost at current scale
- Single deployment artifact — no service mesh, no inter-service auth

**Trade-offs:**
- Single file becomes harder to navigate past ~10K lines
- No traditional middleware composition (custom helper functions instead)
- Worker CPU limits (50ms on free, 30s on paid) constrain computation
- KV is eventually consistent — 60s consistency window on writes
- Testing requires Miniflare (Workers-specific runtime emulator)

**Why not microservices:**
At current scale (65 unique MCP clients/week), the coordination
overhead of multiple services exceeds the complexity of a single file.
The file is well-structured with clear section boundaries documented
in `02_architecture_map.md`. Split when a section needs independent
scaling or a different runtime constraint.
