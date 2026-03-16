/**
 * Multi-Exchange Monitor Template
 *
 * Polls all 7 Headless Oracle exchanges on a configurable interval and
 * emits structured events when status changes. Production-ready template
 * for autonomous trading agents that need continuous market state awareness.
 *
 * Features:
 * - Ed25519 signature verification on every receipt (via @headlessoracle/verify)
 * - Fail-closed: UNKNOWN/HALTED treated as CLOSED, never OPEN
 * - State-change events only (no polling noise)
 * - TTL-aware: never acts on an expired receipt
 * - Graceful degradation: one exchange failure does not halt monitoring of others
 *
 * Usage:
 *   npm install @headlessoracle/verify
 *   ORACLE_API_KEY=your_key ts-node multi-exchange-monitor.ts
 */

import { verify } from '@headlessoracle/verify';

// ── Config ─────────────────────────────────────────────────────────────────

const ORACLE_BASE_URL = 'https://headlessoracle.com';
const API_KEY         = process.env.ORACLE_API_KEY ?? '';
const POLL_INTERVAL_MS = 30_000; // 30 seconds — well within 60s receipt TTL

const ALL_MICS = ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES'] as const;
type MIC = typeof ALL_MICS[number];

// ── Types ──────────────────────────────────────────────────────────────────

type MarketStatus = 'OPEN' | 'CLOSED' | 'HALTED' | 'UNKNOWN';

interface StatusReceipt {
  receipt_id:     string;
  issued_at:      string;
  expires_at:     string;
  mic:            string;
  status:         MarketStatus;
  source:         'SCHEDULE' | 'OVERRIDE' | 'SYSTEM';
  receipt_mode:   'demo' | 'live';
  issuer:         string;
  schema_version: string;
  public_key_id:  string;
  signature:      string;
}

interface MarketState {
  mic:        MIC;
  status:     MarketStatus;
  source:     string;
  receipt_id: string;
  expires_at: string;
  updated_at: number; // Date.now() of last observed change
}

type StatusChangeHandler = (
  mic:     MIC,
  prev:    MarketStatus | null,
  current: MarketStatus,
  receipt: StatusReceipt,
) => void;

// ── Monitor ────────────────────────────────────────────────────────────────

class MultiExchangeMonitor {
  private state    = new Map<MIC, MarketState>();
  private handlers = new Set<StatusChangeHandler>();
  private timer:   ReturnType<typeof setInterval> | null = null;

  constructor(private readonly mics: readonly MIC[] = ALL_MICS) {}

  /** Register a callback that fires on every status change. */
  onStatusChange(handler: StatusChangeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Returns the last known (verified) status for a MIC, or null. */
  getStatus(mic: MIC): MarketStatus | null {
    return this.state.get(mic)?.status ?? null;
  }

  /** Returns true only if the last verified receipt says OPEN and has not expired. */
  isConfirmedOpen(mic: MIC): boolean {
    const s = this.state.get(mic);
    if (!s) return false; // fail-closed: no data = CLOSED
    if (Date.now() > new Date(s.expires_at).getTime()) return false; // expired = CLOSED
    return s.status === 'OPEN';
  }

  /** Start polling. Returns a stop function. */
  start(): () => void {
    void this.poll(); // immediate first poll
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!API_KEY) throw new Error('ORACLE_API_KEY is required — set env var or replace inline');

    // Fetch all MICs in parallel — one failure does not block others
    const results = await Promise.allSettled(
      this.mics.map((mic) => this.fetchAndVerify(mic)),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        // Log but do not throw — monitoring continues for other exchanges
        console.error('[oracle-monitor] poll error:', result.reason);
      }
    }
  }

  private async fetchAndVerify(mic: MIC): Promise<void> {
    const url = `${ORACLE_BASE_URL}/v5/status?mic=${mic}`;

    let receipt: StatusReceipt;
    try {
      const res = await fetch(url, {
        headers: { 'X-Oracle-Key': API_KEY },
        signal:  AbortSignal.timeout(4_000), // 4s — same as fail-closed contract
      });

      if (!res.ok) {
        // Auth failure, server error, etc. — treat as UNKNOWN (fail-closed)
        this.handleVerifiedStatus(mic, 'UNKNOWN', null);
        return;
      }

      receipt = await res.json() as StatusReceipt;
    } catch {
      // Network error — fail-closed
      this.handleVerifiedStatus(mic, 'UNKNOWN', null);
      return;
    }

    // ── Signature verification ─────────────────────────────────────────────
    // Never trust status without verifying the Ed25519 signature.
    // An unverified receipt carries zero attestation weight.
    const verification = await verify(receipt);
    if (!verification.valid) {
      console.warn(`[oracle-monitor] ${mic} signature invalid: ${verification.reason}`);
      this.handleVerifiedStatus(mic, 'UNKNOWN', null);
      return;
    }

    this.handleVerifiedStatus(mic, receipt.status, receipt);
  }

  private handleVerifiedStatus(
    mic:     MIC,
    status:  MarketStatus,
    receipt: StatusReceipt | null,
  ): void {
    const prev    = this.state.get(mic) ?? null;
    const prevStatus = prev?.status ?? null;

    // Always update state (even if no change) to refresh expires_at
    if (receipt) {
      this.state.set(mic, {
        mic,
        status,
        source:     receipt.source,
        receipt_id: receipt.receipt_id,
        expires_at: receipt.expires_at,
        updated_at: prevStatus !== status ? Date.now() : (prev?.updated_at ?? Date.now()),
      });
    } else if (!prev) {
      // First poll with an unverified result — record the UNKNOWN
      this.state.set(mic, {
        mic,
        status:     'UNKNOWN',
        source:     'SYSTEM',
        receipt_id: '',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        updated_at: Date.now(),
      });
    }

    // Fire handlers only on change
    if (prevStatus !== status) {
      for (const handler of this.handlers) {
        try {
          handler(mic, prevStatus, status, receipt!);
        } catch (err) {
          console.error('[oracle-monitor] handler error:', err);
        }
      }
    }
  }
}

// ── Example usage ──────────────────────────────────────────────────────────

const monitor = new MultiExchangeMonitor();

// Register a change handler — replace with your execution logic
monitor.onStatusChange((mic, prev, current, receipt) => {
  const arrow = `${prev ?? 'INIT'} → ${current}`;
  console.log(`[oracle-monitor] ${mic} ${arrow} (receipt: ${receipt?.receipt_id ?? 'none'})`);

  // Fail-closed: UNKNOWN or HALTED → halt execution
  if (current === 'UNKNOWN' || current === 'HALTED') {
    console.warn(`[oracle-monitor] HALT SIGNAL: ${mic} is ${current}. Halting all execution.`);
    // yourBot.halt(mic, current);
  }

  // OPEN → safe to execute (after your own position checks)
  if (current === 'OPEN' && (prev === 'CLOSED' || prev === null)) {
    console.log(`[oracle-monitor] OPEN SIGNAL: ${mic} just opened. Resuming execution gate.`);
    // yourBot.resumeGate(mic);
  }
});

// Optional: query current state at any time
setInterval(() => {
  const snapshot = ALL_MICS.map((mic) => `${mic}:${monitor.getStatus(mic) ?? '—'}`).join(' ');
  console.log(`[oracle-monitor] snapshot: ${snapshot}`);
}, 60_000);

const stop = monitor.start();
console.log('[oracle-monitor] Monitoring 7 exchanges. Press Ctrl+C to stop.');

process.on('SIGINT', () => {
  stop();
  process.exit(0);
});
