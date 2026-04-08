# Incident Response

Last updated: 2026-04-08

## Severity Levels

### P1 — CRITICAL
**Service down, signing broken, or payments broken.**

- Health endpoint returns 500 or CRITICAL_FAILURE
- All status requests returning UNKNOWN/SYSTEM
- x402 payments accepting but not verifying
- Signing key compromised or inaccessible

**Response time**: Immediate
**Escalation**: 5 minutes
**Communication**: Update status page within 15 minutes

### P2 — HIGH
**Degraded performance or incorrect state for specific exchanges.**

- Incorrect OPEN/CLOSED for one or more exchanges
- Elevated error rates (>1% of requests returning 500)
- Halt monitor not detecting known halts
- Webhook delivery failing

**Response time**: 15 minutes
**Escalation**: 30 minutes

### P3 — MEDIUM
**Non-critical endpoint errors or telemetry gaps.**

- Evaluator probe failures (Glama, MCPScoreboard)
- Telemetry KV writes failing (non-blocking, no user impact)
- Discovery endpoints returning stale data
- Non-critical 4xx errors on edge cases

**Response time**: 1 hour
**Escalation**: Next business day

### P4 — LOW
**Documentation, cosmetic, or non-functional issues.**

- Typos in discovery files
- Stale content in LLMS_TXT
- Non-critical test failures in dev

**Response time**: Next business day
**Escalation**: None

## Incident Response Steps

### 1. Detect
- UptimeRobot alerts (health check every 5 min)
- Cloudflare Workers dashboard error spikes
- Evaluator score drops (MCPScoreboard, Glama)
- User reports

### 2. Assess
- Run smoke tests: `npm run test:smoke`
- Check health: `curl https://headlessoracle.com/v5/health`
- Check Cloudflare Workers Observability for error patterns
- Determine severity level

### 3. Mitigate
- **P1**: Rollback immediately (`wrangler rollback`), then investigate
- **P2**: If exchange-specific, set manual override in ORACLE_OVERRIDES KV to force HALTED (safe state). Then investigate.
- **P3/P4**: Investigate and fix in next deploy cycle

### 4. Resolve
- Fix root cause
- Run full test suite (`npm test`)
- Deploy fix
- Verify with smoke tests
- Update KV overrides if any were set during mitigation

### 5. Post-Mortem

Write a post-mortem for all P1 and P2 incidents:

```markdown
## Incident: [Title]

**Date**: YYYY-MM-DD
**Severity**: P1/P2
**Duration**: X minutes/hours
**Impact**: [What users experienced]

## Timeline
- HH:MM — [Event]
- HH:MM — [Event]

## Root Cause (5 Whys)
1. Why did the incident occur?
2. Why was that possible?
3. Why wasn't it caught earlier?
4. Why didn't monitoring detect it?
5. Why wasn't there a safeguard?

## Resolution
[What fixed it]

## Action Items
- [ ] [Action] — Owner — Deadline
- [ ] [Action] — Owner — Deadline
```

## Communication

- **Status page**: status.headlessoracle.com (to be set up)
- **Email**: For P1 incidents affecting paying customers
- **Security incidents**: Follow [SECURITY.md](/SECURITY.md) disclosure policy

## Manual Override (Emergency Circuit Breaker)

To force an exchange to HALTED status (safe state):

```bash
# Set override (2-hour TTL)
wrangler kv:key put --namespace-id={ORACLE_OVERRIDES_ID} "XNYS" \
  '{"status":"HALTED","reason":"manual-override","expires":"2026-04-08T14:00:00Z"}'

# Remove override
wrangler kv:key delete --namespace-id={ORACLE_OVERRIDES_ID} "XNYS"
```

## Related

- [Monitoring](monitoring.md) — What we monitor and alert thresholds
- [Rollback](rollback.md) — How to revert deployments
- [SLA](sla.md) — Uptime commitments and credit policy
