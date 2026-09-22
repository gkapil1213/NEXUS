// src/server/rate-limit.ts
// Phase 180: in-memory token-bucket rate limiter.
//
// Single-process by design -- documented limitation. The repository does
// not have a distributed rate-limit store, and adding one would violate
// the phase brief's "do not invent architecture" rule. A future phase
// with real distributed infra can swap this out.
//
// Buckets are keyed by (bucketName | principal). auth-fail buckets use
// the client address because there is no principal yet.

export type RateLimitBucket = "auth-fail" | "read" | "control";

export interface RateLimitPolicy {
  windowMs: number;
  max: number;
}

export interface RateLimitOptions {
  enabled?: boolean;
  policies?: Partial<Record<RateLimitBucket, RateLimitPolicy>>;
  now?: () => number;
}

const DEFAULTS: Record<RateLimitBucket, RateLimitPolicy> = {
  "auth-fail": { windowMs: 60_000, max: 60 },
  read:         { windowMs: 60_000, max: 600 },
  control:      { windowMs: 60_000, max: 120 },
};

interface BucketState {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

export class RateLimiter {
  private readonly enabled: boolean;
  private readonly policies: Record<RateLimitBucket, RateLimitPolicy>;
  private readonly now: () => number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(opts: RateLimitOptions = {}) {
    this.enabled = opts.enabled !== false;
    this.now = opts.now ?? Date.now;
    this.policies = {
      "auth-fail": { ...DEFAULTS["auth-fail"], ...(opts.policies?.["auth-fail"] ?? {}) },
      read:        { ...DEFAULTS.read,        ...(opts.policies?.read        ?? {}) },
      control:     { ...DEFAULTS.control,     ...(opts.policies?.control     ?? {}) },
    };
  }

  check(principal: string, bucket: RateLimitBucket): RateLimitDecision {
    if (!this.enabled) return { allowed: true, retryAfterSec: 0 };
    const policy = this.policies[bucket];
    const key = bucket + "|" + (principal || "anon");
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + policy.windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    if (b.count > policy.max) {
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - t) / 1000));
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Test-only: clear all buckets. */
  reset(): void { this.buckets.clear(); }
}