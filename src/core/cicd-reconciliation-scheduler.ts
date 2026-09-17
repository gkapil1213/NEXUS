// src/core/cicd-reconciliation-scheduler.ts
//
// Phase 133: bounded, single-flight scheduler that drains open Phase 132
// reconciliation rows via CicdReconciliationService.reconcileOpen().
//
// Design constraints:
//   - No new execution engine, worker pool, or job queue.
//   - One tick at a time per process; concurrent tick() calls coalesce.
//   - Bounded exponential backoff with jitter on retryable failures.
//   - Graceful stop: awaits in-flight tick, prevents any further scheduling.
//   - Deterministic for tests via injectable clock + timer factories.

import type { FencingContext } from "./ci-reconciliation-ownership.service";

export interface ReconciliationDrain {
  reconcileOpen(fence?: FencingContext): Promise<unknown>;
}

/**
 * Phase 134: optional durable ownership. When supplied, every tick first
 * ensures we hold the singleton scheduler ownership; a tick that cannot
 * acquire or renew ownership does NOT call the drain. release() is invoked
 * from stop() as a best-effort cleanup.
 */
export interface SchedulerOwnership {
  ensureOwned(): Promise<{ owned: boolean; reason?: string }>;
  currentFence?(): FencingContext | null;
  release(): Promise<void>;
  workerIdValue?(): string;
  currentLeaseId?(): string | null;
}

export interface SchedulerOptions {
  /** Base interval between ticks (ms). Default 30_000. */
  intervalMs?: number;
  /** Extra random jitter added to every scheduled delay (ms). Default 5_000. */
  jitterMs?: number;
  /** Hard cap on backoff delay after consecutive failures (ms). Default 900_000 (15m). */
  maxBackoffMs?: number;
  /** Optional sink for scheduler-level errors. Best-effort; never throws. */
  onError?: (e: unknown) => void;
  /** Injectable clock — returns ms epoch. Default Date.now. */
  now?: () => number;
  /**
   * Injectable one-shot timer. Default global setTimeout.
   *
   * NOTE: this MUST be setTimeout, not setInterval. scheduleNext() treats the
   * handle as one-shot — the callback drops the reference and the .finally()
   * reschedules. Using setInterval here would create orphan intervals.
   */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Injectable clearer for the one-shot timer. Default global clearTimeout. */
  clearTimeout?: (h: unknown) => void;
  /** Injectable random in [0, 1). Default Math.random. */
  random?: () => number;
  /** Phase 134: durable ownership gate. When present, ticks require ownership. */
  ownership?: SchedulerOwnership;
  /** Phase 134: called whenever a tick is skipped because ownership was not held. */
  onTickSkippedNoOwnership?: (reason: string) => void;
}

export interface TickResult {
  ran: boolean;
  reason?: "already-running" | "stopped" | "coalesced" | "no-ownership";
  durationMs?: number;
  error?: string;
  ownershipReason?: string;
}

export class CicdReconciliationScheduler {
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (h: unknown) => void;
  private readonly random: () => number;
  private readonly onError: (e: unknown) => void;

  private running = false;
  private timerHandle: unknown = null;
  private inFlight: Promise<TickResult> | null = null;
  private consecutiveFailures = 0;
  private lastTickStartedAt = 0;
  private lastTickDurationMs = 0;
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private readonly ownership?: SchedulerOwnership;
  private readonly onTickSkippedNoOwnership?: (reason: string) => void;
  private skippedNoOwnership = 0;
  private ownsForStatus = false;

  constructor(
    private readonly drain: ReconciliationDrain,
    opts: SchedulerOptions = {},
  ) {
    this.intervalMs = Math.max(1_000, opts.intervalMs ?? 30_000);
    this.jitterMs = Math.max(0, opts.jitterMs ?? 5_000);
    this.maxBackoffMs = Math.max(this.intervalMs, opts.maxBackoffMs ?? 900_000);
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.random = opts.random ?? Math.random;
    this.onError = opts.onError ?? (() => {});
    this.ownership = opts.ownership;
    this.onTickSkippedNoOwnership = opts.onTickSkippedNoOwnership;
  }

  isRunning(): boolean {
    return this.running;
  }

  isTickInFlight(): boolean {
    return this.inFlight !== null;
  }

  stats(): {
    running: boolean;
    inFlight: boolean;
    consecutiveFailures: number;
    lastTickStartedAt: number;
    lastTickDurationMs: number;
    lastError: string | null;
    startedAt: number | null;
    skippedNoOwnership: number;
    owner: boolean;
    workerId: string | null;
  } {
    return {
      running: this.running,
      inFlight: this.inFlight !== null,
      consecutiveFailures: this.consecutiveFailures,
      lastTickStartedAt: this.lastTickStartedAt,
      lastTickDurationMs: this.lastTickDurationMs,
      lastError: this.lastError,
      startedAt: this.startedAt,
      skippedNoOwnership: this.skippedNoOwnership,
      owner: !this.ownership || this.ownsForStatus,
      workerId: this.ownership?.workerIdValue?.() ?? null,
    };
  }

  /** Idempotent. Repeated calls while running are no-ops. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.scheduleNext(0);
  }

  /** Graceful stop: awaits any in-flight tick, then releases the timer + ownership. */
  async stop(): Promise<void> {
    if (!this.running && this.timerHandle === null && this.inFlight === null) return;
    this.running = false;
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.inFlight) {
      try { await this.inFlight; } catch { /* never throw from stop */ }
    }
    if (this.ownership) {
      try { await this.ownership.release(); } catch { /* best-effort */ }
    }
    this.ownsForStatus = false;
  }

  /**
   * Run one tick immediately. Ownership-gated when ownership is configured.
   * Never bypasses ownership. Safe to call externally (manual "reconcile now").
   */
  async tickNow(): Promise<TickResult> {
    if (this.inFlight) {
      return { ran: false, reason: "coalesced" };
    }
    const started = this.now();
    this.lastTickStartedAt = started;

    if (this.ownership) {
      let state: { owned: boolean; reason?: string };
      try {
        state = await this.ownership.ensureOwned();
      } catch (e) {
        state = {
          owned: false,
          reason: "ownership-call-threw:" + String((e as Error).message ?? e).slice(0, 120),
        };
      }
      if (!state.owned) {
        this.skippedNoOwnership++;
        this.ownsForStatus = false;
        const dur = this.now() - started;
        this.lastTickDurationMs = dur;
        try { this.onTickSkippedNoOwnership?.(state.reason ?? "unknown"); } catch { /* best-effort */ }
        return { ran: false, reason: "no-ownership", durationMs: dur, ownershipReason: state.reason };
      }
      this.ownsForStatus = true;
    }

    const p = this.runTick(started);
    this.inFlight = p;
    try {
      return await p;
    } finally {
      this.inFlight = null;
    }
  }

  /** Phase 134: ownership-gated alias for tickNow(). Never bypasses ownership. */
  async runNow(): Promise<TickResult> {
    return this.tickNow();
  }

  private async runTick(started: number): Promise<TickResult> {
    try {
      const fence = this.ownership?.currentFence?.() ?? undefined;
      await this.drain.reconcileOpen(fence);
      this.consecutiveFailures = 0;
      this.lastError = null;
      const dur = this.now() - started;
      this.lastTickDurationMs = dur;
      return { ran: true, durationMs: dur };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      this.consecutiveFailures += 1;
      this.lastError = msg;
      const dur = this.now() - started;
      this.lastTickDurationMs = dur;
      try { this.onError(e); } catch { /* swallow */ }
      return { ran: true, durationMs: dur, error: msg };
    }
  }

  private scheduleNext(explicitDelayMs?: number): void {
    if (!this.running) return;
    const delay = explicitDelayMs !== undefined
      ? explicitDelayMs
      : this.nextDelay();
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = null;
    }
    this.timerHandle = this.setTimeoutFn(() => {
      this.timerHandle = null;
      if (!this.running) return;
      void this.tickNow().finally(() => {
        if (this.running) this.scheduleNext();
      });
    }, delay);
  }

  /** Bounded exponential backoff + jitter based on consecutive failures. */
  private nextDelay(): number {
    const base = Math.min(
      this.maxBackoffMs,
      this.intervalMs * Math.pow(2, Math.min(this.consecutiveFailures, 10)),
    );
    const jitter = this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0;
    return base + jitter;
  }
}