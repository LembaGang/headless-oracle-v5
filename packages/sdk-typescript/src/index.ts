/**
 * @headlessoracle/sdk — TypeScript SDK for Headless Oracle
 *
 * Ed25519-signed market-state attestations for 28 global exchanges.
 * UNKNOWN = CLOSED (fail-closed). Receipts expire after 60 seconds.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Market status. UNKNOWN MUST be treated as CLOSED — halt all execution. */
export type MarketStatus = 'OPEN' | 'CLOSED' | 'HALTED' | 'UNKNOWN';

/** Source of the status determination. */
export type StatusSource = 'SCHEDULE' | 'OVERRIDE' | 'SYSTEM' | 'REALTIME';

/** Receipt mode: demo (unauthenticated) or live (authenticated). */
export type ReceiptMode = 'demo' | 'live';

/** Ed25519-signed market-state receipt. */
export interface SignedReceipt {
  receipt_id: string;
  issued_at: string;
  expires_at: string;
  issuer: string;
  mic: string;
  status: MarketStatus;
  source: StatusSource;
  reason?: string;
  halt_detection: 'active' | 'schedule_only';
  receipt_mode: ReceiptMode;
  schema_version: string;
  public_key_id: string;
  signature: string;
}

/** Wrapper returned by /v5/status and /v5/demo. */
export interface StatusResponse extends SignedReceipt {
  discovery_url: string;
  receipt: SignedReceipt;
  extensions?: Record<string, unknown>;
}

/** Batch response from /v5/batch. */
export interface BatchResponse {
  batch_id: string;
  correlation_id: string;
  queried_at: string;
  receipts: SignedReceipt[];
  exchanges: Record<string, SignedReceipt>;
  summary: BatchSummary;
  batch_signature: string;
}

export interface BatchSummary {
  total: number;
  open: number;
  closed: number;
  halted: number;
  unknown: number;
  all_open: boolean;
  any_halted: boolean;
  safe_to_execute: boolean;
  reason: string;
}

/** Historical reconstruction (unsigned). */
export interface HistoricalResponse {
  mic: string;
  queried_at: string;
  computed_status: MarketStatus;
  source: 'SCHEDULE_RECONSTRUCTION';
  reasoning: Record<string, unknown>;
  dst_note: string | null;
  disclaimer: string;
  schema_version: string;
}

/** Exchange info from /v5/exchanges. */
export interface Exchange {
  mic: string;
  name: string;
  timezone: string;
  mic_type: 'iso' | 'convention';
}

/** Schedule info from /v5/schedule. */
export interface ScheduleResponse {
  mic: string;
  name: string;
  timezone: string;
  queried_at: string;
  current_status: MarketStatus;
  next_open: string | null;
  next_close: string | null;
  data_coverage_years: string[];
  lunch_break: { start: string; end: string } | null;
  settlement_window: string | null;
  note: string;
}

/** Verification result. */
export interface VerifyResult {
  valid: boolean;
  expired: boolean;
  reason: string;
  mic: string | null;
  status: string | null;
  expires_at: string | null;
  checks?: Record<string, boolean>;
}

/** Instant key response. */
export interface InstantKeyResponse {
  api_key: string;
  daily_limit: number;
  plan: string;
  created_at: string;
  usage: string;
  example: string;
  upgrade_url: string;
}

/** Health response. */
export interface HealthResponse {
  receipt_id: string;
  issued_at: string;
  expires_at: string;
  status: 'OK';
  source: 'SYSTEM';
  public_key_id: string;
  signature: string;
  exchange_count: number;
  supported_mics: string[];
}

/** Market briefing. */
export interface BriefingResponse {
  briefing_date: string;
  briefing_time_utc: string;
  markets_open_now: string[];
  markets_closed_now: string[];
  markets_in_lunch_break: string[];
  upcoming_opens: Array<{ mic: string; opens_at: string; in_minutes: number }>;
  upcoming_closes: Array<{ mic: string; closes_at: string; in_minutes: number }>;
  holidays_today: string[];
  coverage: number;
}

/** SDK error with structured info from the API. */
export class OracleError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OracleError';
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface HeadlessOracleOptions {
  /** API key (ho_free_, ho_live_, sb_, ho_crd_ prefix). */
  apiKey?: string;
  /** Base URL. Default: https://headlessoracle.com */
  baseUrl?: string;
  /** Ed25519 public key hex for offline verification. Fetched from /v5/keys if omitted. */
  publicKey?: string;
  /** Max retries on 429. Default: 3. */
  maxRetries?: number;
  /** Custom fetch implementation (for testing). */
  fetch?: typeof globalThis.fetch;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class HeadlessOracle {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private publicKeyHex: string | undefined;
  private readonly maxRetries: number;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(options: HeadlessOracleOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://headlessoracle.com').replace(/\/$/, '');
    this.publicKeyHex = options.publicKey;
    this.maxRetries = options.maxRetries ?? 3;
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ── Core Methods ─────────────────────────────────────────────────────────

  /**
   * Get a signed market-state receipt for one exchange.
   * Uses /v5/status (authenticated) if apiKey is set, otherwise /v5/demo.
   */
  async getStatus(mic: string): Promise<StatusResponse> {
    const endpoint = this.apiKey ? '/v5/status' : '/v5/demo';
    return this.request<StatusResponse>(`${endpoint}?mic=${encodeURIComponent(mic.toUpperCase())}`);
  }

  /** Get a public demo receipt (never uses API key). */
  async getDemo(mic: string): Promise<StatusResponse> {
    return this.request<StatusResponse>(`/v5/demo?mic=${encodeURIComponent(mic.toUpperCase())}`);
  }

  /** Batch signed receipts for multiple exchanges. */
  async batch(mics: string[]): Promise<BatchResponse> {
    const param = mics.map(m => m.toUpperCase()).join(',');
    return this.request<BatchResponse>(`/v5/batch?mics=${encodeURIComponent(param)}`);
  }

  /** Historical market-state reconstruction (unsigned). */
  async historical(mic: string, at: string): Promise<HistoricalResponse> {
    return this.request<HistoricalResponse>(
      `/v5/historical?mic=${encodeURIComponent(mic.toUpperCase())}&at=${encodeURIComponent(at)}`,
    );
  }

  /** Get next open/close times for an exchange. */
  async getSchedule(mic: string): Promise<ScheduleResponse> {
    return this.request<ScheduleResponse>(`/v5/schedule?mic=${encodeURIComponent(mic.toUpperCase())}`);
  }

  /** List all 28 supported exchanges. */
  async listExchanges(): Promise<{ exchanges: Exchange[] }> {
    return this.request<{ exchanges: Exchange[] }>('/v5/exchanges');
  }

  /** Signed liveness probe. */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/v5/health');
  }

  /** Daily market intelligence snapshot. */
  async briefing(): Promise<BriefingResponse> {
    return this.request<BriefingResponse>('/v5/briefing');
  }

  // ── Verification ─────────────────────────────────────────────────────────

  /**
   * Verify a receipt's Ed25519 signature and TTL.
   * Uses the server-side /v5/verify endpoint.
   * For offline verification, use `verifyOffline()`.
   */
  async verify(receipt: SignedReceipt | Record<string, unknown>): Promise<VerifyResult> {
    return this.request<VerifyResult>('/v5/verify', {
      method: 'POST',
      body: JSON.stringify({ receipt }),
    });
  }

  /**
   * Verify a receipt offline using Web Crypto Ed25519.
   * Requires Node.js 18+ or a browser with Ed25519 support.
   */
  async verifyOffline(receipt: SignedReceipt): Promise<{ valid: boolean; expired: boolean; reason: string }> {
    // Check expiry
    const now = new Date();
    const expiresAt = new Date(receipt.expires_at);
    if (now > expiresAt) {
      return { valid: false, expired: true, reason: 'RECEIPT_EXPIRED' };
    }

    // Get public key
    const pubKeyHex = await this.getPublicKey();
    if (!pubKeyHex) {
      return { valid: false, expired: false, reason: 'PUBLIC_KEY_UNAVAILABLE' };
    }

    // Build canonical payload (alphabetical key sort, no whitespace)
    const { signature, ...payload } = receipt;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(payload).sort()) {
      sorted[k] = (payload as Record<string, unknown>)[k];
    }
    const canonical = JSON.stringify(sorted);
    const msgBytes = new TextEncoder().encode(canonical);

    // Import public key and verify
    try {
      const keyBytes = hexToBytes(pubKeyHex);
      const sigBytes = hexToBytes(signature);
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      const valid = await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, msgBytes);
      return { valid, expired: false, reason: valid ? 'SIGNATURE_VALID' : 'INVALID_SIGNATURE' };
    } catch {
      return { valid: false, expired: false, reason: 'VERIFICATION_ERROR' };
    }
  }

  // ── Key Management ───────────────────────────────────────────────────────

  /**
   * Get an instant free API key (zero friction, one per agent_id).
   * Returns the key on first call, same key on subsequent calls with same agent_id.
   */
  async getInstantKey(agentId: string): Promise<InstantKeyResponse> {
    return this.request<InstantKeyResponse>('/v5/keys/instant', {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId }),
    });
  }

  /** Get the Ed25519 public key from /v5/keys. Caches after first fetch. */
  async getPublicKey(): Promise<string | undefined> {
    if (this.publicKeyHex) return this.publicKeyHex;
    try {
      const resp = await this.request<{ keys: Array<{ public_key: string }> }>('/v5/keys');
      this.publicKeyHex = resp.keys[0]?.public_key;
      return this.publicKeyHex;
    } catch {
      return undefined;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Check if it's safe to execute a trade on the given exchange.
   * Returns true only if status is OPEN.
   */
  async isSafeToExecute(mic: string): Promise<boolean> {
    const receipt = await this.getStatus(mic);
    return receipt.status === 'OPEN';
  }

  /**
   * Check if ALL given exchanges are open (batch variant).
   */
  async allOpen(mics: string[]): Promise<boolean> {
    const batch = await this.batch(mics);
    return batch.summary.all_open;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(this.apiKey ? { 'X-Oracle-Key': this.apiKey } : {}),
    };

    let lastError: OracleError | Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s, 4s
        await sleep(1000 * Math.pow(2, attempt - 1));
      }

      let resp: Response;
      try {
        resp = await this._fetch(url, { ...init, headers });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      if (resp.status === 429) {
        // Rate limited — retry with backoff
        const retryAfter = resp.headers.get('Retry-After');
        if (retryAfter && attempt < this.maxRetries) {
          await sleep(parseInt(retryAfter, 10) * 1000 || 1000);
        }
        lastError = new OracleError('Rate limited', 429, 'RATE_LIMITED', await resp.json().catch(() => ({})));
        continue;
      }

      if (resp.status === 402 && !this.apiKey) {
        // No API key and hit payment wall — auto-provision an instant key
        try {
          const keyResp = await this.getInstantKey(`sdk-auto-${Date.now()}`);
          (this as { apiKey: string | undefined }).apiKey = keyResp.api_key;
          // Retry the original request with the new key
          headers['X-Oracle-Key'] = keyResp.api_key;
          const retryResp = await this._fetch(url, { ...init, headers });
          if (!retryResp.ok) {
            const body = await retryResp.json().catch(() => ({}));
            throw new OracleError(
              (body as Record<string, string>).message ?? `HTTP ${retryResp.status}`,
              retryResp.status,
              (body as Record<string, string>).error ?? 'UNKNOWN',
              body as Record<string, unknown>,
            );
          }
          return await retryResp.json() as T;
        } catch (e) {
          if (e instanceof OracleError) throw e;
          // Auto-provision failed — throw original 402
          const body = await resp.json().catch(() => ({}));
          throw new OracleError('Payment required', 402, 'PAYMENT_REQUIRED', body as Record<string, unknown>);
        }
      }

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
        throw new OracleError(
          (body.message as string) ?? `HTTP ${resp.status}`,
          resp.status,
          (body.error as string) ?? 'UNKNOWN',
          body,
        );
      }

      return await resp.json() as T;
    }

    throw lastError ?? new Error('Request failed after retries');
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default HeadlessOracle;
