import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface LimitState {
  limited: boolean;
  retryAfterSec: number;
}

export interface LimiterOptions {
  windowMs: number;
  /** Events allowed per key per window. */
  max: number;
  /** Cap on tracked keys, so a flood of unique keys can't grow memory without bound. */
  maxKeys?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * In-memory fixed-window counter. Good for one instance, which is what the free
 * plan gives you. With several instances each one counts on its own, so the
 * real limit is up to (instances x max); move the counters to Redis before
 * relying on exact numbers.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly max: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: LimiterOptions) {
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  private live(key: string): Bucket | undefined {
    const bucket = this.buckets.get(key);

    if (bucket && bucket.resetAt <= this.now()) {
      this.buckets.delete(key);
      return undefined;
    }

    return bucket;
  }

  private state(bucket: Bucket, limited: boolean): LimitState {
    return {
      limited,
      retryAfterSec: limited
        ? Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000))
        : 0,
    };
  }

  /** Looks without counting: is this key already at its limit? */
  check(key: string): LimitState {
    const bucket = this.live(key);

    return bucket
      ? this.state(bucket, bucket.count >= this.max)
      : { limited: false, retryAfterSec: 0 };
  }

  /** Counts one event. `limited` turns true once the count goes past `max`. */
  hit(key: string): LimitState {
    let bucket = this.live(key);

    if (!bucket) {
      this.makeRoom();
      bucket = { count: 0, resetAt: this.now() + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    return this.state(bucket, bucket.count > this.max);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private makeRoom(): void {
    if (this.buckets.size < this.maxKeys) {
      return;
    }

    for (const key of [...this.buckets.keys()]) {
      this.live(key);
    }

    // Still full: drop the oldest entry.
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;

      if (oldest !== undefined) {
        this.buckets.delete(oldest);
      }
    }
  }
}

export function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function humanWait(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** 429 with a Retry-After header and a message the web app can show as is. */
export function tooMany(
  res: Response,
  retryAfterSec: number,
  message: string
): void {
  res.set("Retry-After", String(retryAfterSec));
  res
    .status(429)
    .json({ message: `${message} Try again in ${humanWait(retryAfterSec)}.` });
}

/** Counts every request from one client address; rejects once it is over the limit. */
export function limitByIp(
  limiter: RateLimiter,
  message = "Too many requests."
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = limiter.hit(req.ip ?? "unknown");

    if (result.limited) {
      tooMany(res, result.retryAfterSec, message);
      return;
    }

    next();
  };
}
