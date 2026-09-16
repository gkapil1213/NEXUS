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

export interface ReconciliationDrain {
  reconcileOpen(): Promise<unknown>;
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
  /** Injectable timer. Default global setInterval. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** Injectable clearer. Default global clearInterval. */
  clearInterval?: (h: unknown) => void;
  /** Injectable random in [0, 1). Default Math.random. */
  random?: () => number;
}

export interface TickResult {
  ran: boolean;
  reason?: "already-running" | "stopped" | "coalesced";
  durationMs?: number;
  error?: string;
}

export class CicdReconciliationScheduler {
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly setI: (fn: () => void, ms: number) => unknown;
  private readonly clearI: (h: unknown) => void;
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

  constructor(
    private readonly drain: ReconciliationDrain,
    opts: SchedulerOptions = {},
  ) {
    this.intervalMs = Math.max(1_000, opts.intervalMs ?? 30_000);
    this.jitterMs = Math.max(0, opts.jitterMs ?? 5_000);
    this.maxBackoffMs = Math.max(this.intervalMs, opts.maxBackoffMs ?? 900_000);
    this.now = opts.now ?? Date.now;
    this.setI = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearI = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.random = opts.random ?? Math.random;
    this.onError = opts.onError ?? (() => {});
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
  } {
    return {
      running: this.running,
      inFlight: this.inFlight !== null,
      consecutiveFailures: this.consecutiveFailures,
      lastTickStartedAt: this.lastTickStartedAt,
      lastTickDurationMs: this.lastTickDurationMs,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  /** Idempotent. Repeated calls while running are no-ops. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.scheduleNext(0);
  }

  /** Graceful stop: awaits any in-flight tick, then releases the timer. */
  async stop(): Promise<void> {
    if (!this.running && this.timerHandle === null && this.inFlight === null) return;
    this.running = false;
    if (this.timerHandle !== null) {
      this.clearI(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.inFlight) {
      try { await this.inFlight; } catch { /* never throw from stop */ }
    }
  }

  /**
   * Run one tick immediately, respecting single-flight. Safe to call
   * externally (e.g. tests, or a manual "reconcile now" API).
   */
  async tickNow(): Promise<TickResult> {
    if (this.inFlight) {
      return { ran: false, reason: "coalesced" };
    }
    const started = this.now();
    this.lastTickStartedAt = started;
    const p = this.runTick(started);
    this.inFlight = p;
    try {
      return await p;
    } finally {
      this.inFlight = null;
    }
  }

  private async runTick(started: number): Promise<TickResult> {
    try {
      await this.drain.reconcileOpen();
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
      this.clearI(this.timerHandle);
      this.timerHandle = null;
    }
    this.timerHandle = this.setI(() => {
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