import type { Request, RequestHandler, Response } from "express";

/**
 * A small in-memory rate limiter: no dependency, one fixed window per key.
 *
 * Limits are per process. On a single instance (the free tier) that is exact;
 * with several replicas each one counts on its own, so the effective limit is
 * roughly replicas x max. A restart clears the counters. Both are acceptable
 * for slowing down guessing; a gateway in front is the stronger defence.
 */
export interface LimiterOptions {
  windowMs: number;
  /** Events allowed per key per window. */
  max: number;
  /** Cap on tracked keys, so a flood of random keys can't exhaust memory. */
  maxKeys?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface HitResult {
  allowed: boolean;
  retryAfterSec: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: LimiterOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);

    if (!entry) return undefined;

    if (entry.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry;
  }

  private retryAfter(entry: Entry): number {
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  private make(key: string): Entry {
    if (this.entries.size >= this.maxKeys) {
      const now = this.now();

      for (const [k, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(k);
      }

      // Still full: drop the oldest keys rather than grow without bound.
      for (const k of this.entries.keys()) {
        if (this.entries.size < this.maxKeys) break;
        this.entries.delete(k);
      }
    }

    const entry = { count: 0, resetAt: this.now() + this.options.windowMs };
    this.entries.set(key, entry);
    return entry;
  }

  /** Count one event. `allowed` is false once the key is over its limit. */
  hit(key: string): HitResult {
    const entry = this.live(key) ?? this.make(key);
    entry.count += 1;

    return {
      allowed: entry.count <= this.options.max,
      retryAfterSec: this.retryAfter(entry),
    };
  }

  /**
   * For failure counters: true once `max` failures were recorded, without
   * counting anything. Check it before doing the expensive work.
   */
  isBlocked(key: string): HitResult & { blocked: boolean } {
    const entry = this.live(key);

    if (!entry) return { blocked: false, allowed: true, retryAfterSec: 0 };

    const blocked = entry.count >= this.options.max;

    return { blocked, allowed: !blocked, retryAfterSec: blocked ? this.retryAfter(entry) : 0 };
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const windowMs = () => positive(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60_000);

/**
 * Every limiter lives here so tests can clear them all at once. The numbers
 * are generous for real people and tiny for a guessing script; all can be
 * changed with environment variables.
 */
export const limits = {
  /** Every login attempt from one address (also bounds the CPU spent on password hashing). */
  loginPerIp: new RateLimiter({
    windowMs: windowMs(),
    max: positive(process.env.LOGIN_MAX_PER_IP, 100),
  }),
  /** Failed logins for one account from one address. */
  loginFailsPerAccountIp: new RateLimiter({
    windowMs: windowMs(),
    max: positive(process.env.LOGIN_FAILS_PER_ACCOUNT_IP, 5),
  }),
  /** Failed logins for one account from anywhere: stops a guesser who rotates addresses. */
  loginFailsPerAccount: new RateLimiter({
    windowMs: windowMs(),
    max: positive(process.env.LOGIN_FAILS_PER_ACCOUNT, 20),
  }),
  refreshPerIp: new RateLimiter({
    windowMs: windowMs(),
    max: positive(process.env.REFRESH_MAX_PER_IP, 300),
  }),
  /** Refreshes with a token that doesn't exist or was already used. */
  refreshFailsPerIp: new RateLimiter({
    windowMs: windowMs(),
    max: positive(process.env.REFRESH_FAILS_PER_IP, 30),
  }),
};

export function resetRateLimits(): void {
  for (const limiter of Object.values(limits)) limiter.clear();
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function tooManyRequests(res: Response, retryAfterSec: number): void {
  res.set("Retry-After", String(retryAfterSec));
  res.status(429).json({ message: "Too many attempts. Please try again later." });
}

/** Counts every request from an address and answers 429 once it is over its limit. */
export function limitByIp(limiter: RateLimiter, what: string): RequestHandler {
  return (req, res, next) => {
    const ip = clientIp(req);
    const result = limiter.hit(ip);

    if (!result.allowed) {
      console.warn(`Rate limit hit: ${what} ip=${ip}`);
      tooManyRequests(res, result.retryAfterSec);
      return;
    }

    next();
  };
}

/**
 * How many reverse proxies sit in front of this service, for Express's
 * `trust proxy`. It decides which address counts as the caller's: too low and
 * everyone shares the proxy's address; too high and callers can forge their own
 * through X-Forwarded-For. 1 suits one proxy (Render's load balancer, nginx).
 * Behind Vercel's rewrite and Render's load balancer, use 2.
 */
export function trustProxySetting(
  value: string | undefined = process.env.TRUST_PROXY
): number | false {
  if (value === undefined || value.trim() === "") return 1;
  if (value.trim().toLowerCase() === "false") return false;

  const hops = Number(value);

  if (Number.isInteger(hops) && hops >= 0) return hops === 0 ? false : hops;

  console.warn(`Ignoring TRUST_PROXY="${value}": use a number of proxy hops, or "false". Using 1.`);
  return 1;
}
