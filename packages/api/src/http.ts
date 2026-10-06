import { createHash, randomBytes } from "node:crypto";

/** Request ids the API accepts from a caller. Anything else gets a fresh id. */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function readOrCreateRequestId(header: string | undefined | null): string {
  const trimmed = header?.trim() ?? "";
  if (REQUEST_ID_RE.test(trimmed)) return trimmed;
  return `req_${randomBytes(12).toString("hex")}`;
}

/**
 * Client address for rate limits. roster-api listens on 127.0.0.1 behind the
 * roster.network proxy, so the forwarded headers come from our own proxy.
 */
export function clientAddress(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  return "local";
}

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetS: number;
}

/** Fixed-window counters in memory. One PM2 instance serves roster-api today. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  hit(key: string, rule: RateLimitRule, cost = 1): RateLimitDecision {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      window = { count: 0, resetAt: now + rule.windowMs };
      this.windows.set(key, window);
    }
    window.count += cost;
    const allowed = window.count <= rule.limit;
    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - window.count),
      resetS: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  /** Read a window without counting a request. */
  peek(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      return { allowed: true, limit: rule.limit, remaining: rule.limit, resetS: Math.ceil(rule.windowMs / 1000) };
    }
    return {
      allowed: window.count < rule.limit,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - window.count),
      resetS: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}

export interface RateLimitConfig {
  /** Sign-up, login, session exchange, and organization creation, per client address. */
  auth: RateLimitRule;
  /** Anonymous sandbox API keys per client address (stricter than email signup). */
  anonymous: RateLimitRule;
  /** Waitlist sign-ups per client address. */
  waitlist: RateLimitRule;
  /** Failed API key or admin token attempts per client address. */
  authFailures: RateLimitRule;
  /** Authenticated calls per organization. */
  organization: RateLimitRule;
  /** Unauthenticated public reads per client address. */
  publicRead: RateLimitRule;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  auth: { limit: 20, windowMs: 60_000 },
  anonymous: { limit: 5, windowMs: 60 * 60_000 },
  waitlist: { limit: 10, windowMs: 60_000 },
  authFailures: { limit: 30, windowMs: 10 * 60_000 },
  organization: { limit: 1200, windowMs: 60_000 },
  publicRead: { limit: 300, windowMs: 60_000 },
};

/**
 * `ROSTER_RATE_LIMIT=0` (or `off`/`false`) turns the limiter off.
 * Anything else, including unset, keeps the defaults.
 */
export function resolveRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig | null {
  const raw = env.ROSTER_RATE_LIMIT?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return null;
  return DEFAULT_RATE_LIMITS;
}

export function resolveAccessLog(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ROSTER_ACCESS_LOG?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export const IDEMPOTENCY_HEADER = "idempotency-key";
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_RE.test(value);
}

export interface StoredIdempotentResponse {
  fingerprint: string;
  status: number;
  body: string;
  contentType: string | null;
  expiresAt: number;
}

/**
 * Replays the first response for an `Idempotency-Key` within 24 hours.
 * Keys are scoped to the organization, method, and path. Server errors are not stored.
 */
export class IdempotencyCache {
  private readonly done = new Map<string, StoredIdempotentResponse>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 20_000,
  ) {}

  static scope(organizationId: string, method: string, path: string, key: string): string {
    return `${organizationId}\n${method}\n${path}\n${key}`;
  }

  static fingerprint(body: string): string {
    return createHash("sha256").update(body, "utf8").digest("hex");
  }

  lookup(scope: string): StoredIdempotentResponse | "pending" | null {
    if (this.pending.has(scope)) return "pending";
    const stored = this.done.get(scope);
    if (!stored) return null;
    if (stored.expiresAt <= this.now()) {
      this.done.delete(scope);
      return null;
    }
    return stored;
  }

  begin(scope: string): void {
    this.pending.add(scope);
  }

  abort(scope: string): void {
    this.pending.delete(scope);
  }

  finish(scope: string, response: Omit<StoredIdempotentResponse, "expiresAt">): void {
    this.pending.delete(scope);
    if (this.done.size >= this.maxEntries) {
      const now = this.now();
      for (const [key, value] of this.done) {
        if (value.expiresAt <= now) this.done.delete(key);
      }
      // Still full: drop the oldest insertions first.
      for (const key of this.done.keys()) {
        if (this.done.size < this.maxEntries) break;
        this.done.delete(key);
      }
    }
    this.done.set(scope, { ...response, expiresAt: this.now() + IDEMPOTENCY_TTL_MS });
  }
}
