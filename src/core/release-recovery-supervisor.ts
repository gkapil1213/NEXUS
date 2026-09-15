// src/core/release-recovery-supervisor.ts
// Phase 125: lifecycle-managed production recovery supervisor.
//
// Thin lifecycle wrapper around the existing ReleaseRecoveryExecutor.
// Does NOT implement recovery logic, does NOT construct a second executor,
// does NOT open network ports, does NOT auto-start from kernel.boot().
//
// Mirrors the startGateway()/stopGateway() lifecycle philosophy:
//   - opt-in (CONFIG.recovery.enabled)
//   - idempotent start/stop
//   - explicit lifecycle calls only

import type {
  ReleaseRecoveryExecutor,
  RecoveryRunReport,
} from "./release-recovery-executor";

export type RecoverySupervisorState =
  | "STOPPED"
  | "STARTING"
  | "RUNNING"
  | "STOPPING"
  | "FAILED";

export interface RecoverySupervisorStatus {
  state: RecoverySupervisorState;
  workerId: string;
  startedAt: number | null;
  lastRunAt: number | null;
  lastRunDurationMs: number | null;
  lastRunResult: RecoveryRunReport | null;
  lastError: string | null;
  consecutiveFailures: number;
  skippedTicks: number;
  activeRun: boolean;
}

export interface RecoverySupervisorEventSink {
  emit(e: {
    type: string;
    source?: string;
    execution_id?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<unknown> | unknown;
}

export interface RecoverySupervisorAuditSink {
  record(e: {
    actor: string;
    action: string;
    resource_type: string;
    resource_id: string;
    result?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> | unknown;
}

export interface ReleaseRecoverySupervisorDeps {
  executor: ReleaseRecoveryExecutor;
  svc: {
    events: RecoverySupervisorEventSink;
    audit: RecoverySupervisorAuditSink;
  };
  workerId: string;
  intervalMs: number;
}

const SOURCE = "ReleaseRecoverySupervisor";

type SupervisorTrigger = "scheduled" | "manual" | "final";

export class ReleaseRecoverySupervisor {
  private readonly deps: ReleaseRecoverySupervisorDeps;
  private state: RecoverySupervisorState = "STOPPED";
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<RecoveryRunReport> | null = null;

  private startedAt: number | null = null;
  private lastRunAt: number | null = null;
  private lastRunDurationMs: number | null = null;
  private lastRunResult: RecoveryRunReport | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private skippedTicks = 0;

  constructor(deps: ReleaseRecoverySupervisorDeps) {
    if (!deps.workerId) {
      throw new Error("ReleaseRecoverySupervisor requires a stable workerId");
    }
    const ms = deps.intervalMs;
    if (!Number.isFinite(ms) || ms <= 0 || Math.floor(ms) !== ms) {
      throw new Error(
        `ReleaseRecoverySupervisor: intervalMs must be a positive integer, got ${String(ms)}`,
      );
    }
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.state === "RUNNING" || this.state === "STARTING") {
      return;
    }
    if (this.state === "STOPPING") {
      throw new Error("ReleaseRecoverySupervisor: cannot start while STOPPING");
    }
    this.state = "STARTING";
    try {
      await this.safeEmit("release.recovery.supervisor.started", {
        workerId: this.deps.workerId,
        intervalMs: this.deps.intervalMs,
      });

      this.timer = setInterval(() => {
        void this.tick();
      }, this.deps.intervalMs);
      (this.timer as unknown as { unref?: () => void }).unref?.();

      this.startedAt = Date.now();
      this.state = "RUNNING";

      await this.safeAudit({
        actor: this.deps.workerId,
        action: "release.recovery.supervisor.start",
        resource_type: "release_recovery_supervisor",
        resource_id: this.deps.workerId,
        result: "ok",
        metadata: { intervalMs: this.deps.intervalMs },
      });
    } catch (e) {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.startedAt = null;
      this.lastError = ReleaseRecoverySupervisor.normalizeError(e);
      this.state = "FAILED";
      throw e;
    }
  }

  async stop(options?: { finalPass?: boolean }): Promise<void> {
    if (this.state === "STOPPED" && this.timer === null && this.inFlight === null) {
      return;
    }
    this.state = "STOPPING";

    // Cleanup timer first. Never leave a scheduler alive regardless of any
    // subsequent failure (active run, final pass, telemetry).
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait for any active run to finish before considering a final pass.
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // Outcome already recorded on status; not a stop failure.
      }
    }

    let finalPassError: unknown = null;
    if (options?.finalPass) {
      try {
        await this.runGuarded("final");
      } catch (e) {
        finalPassError = e;
      }
    }

    this.startedAt = null;
    this.state = finalPassError ? "FAILED" : "STOPPED";

    await this.safeEmit("release.recovery.supervisor.stopped", {
      workerId: this.deps.workerId,
      finalPass: !!options?.finalPass,
      finalPassFailed: finalPassError !== null,
    });
    await this.safeAudit({
      actor: this.deps.workerId,
      action: "release.recovery.supervisor.stop",
      resource_type: "release_recovery_supervisor",
      resource_id: this.deps.workerId,
      result: finalPassError ? "blocked" : "ok",
      metadata: finalPassError
        ? {
            finalPass: true,
            error: ReleaseRecoverySupervisor.normalizeError(finalPassError),
          }
        : { finalPass: !!options?.finalPass },
    });
  }

  async runNow(): Promise<RecoveryRunReport> {
    if (this.inFlight) {
      return this.inFlight;
    }
    return this.runGuarded("manual");
  }

  status(): RecoverySupervisorStatus {
    return {
      state: this.state,
      workerId: this.deps.workerId,
      startedAt: this.startedAt,
      lastRunAt: this.lastRunAt,
      lastRunDurationMs: this.lastRunDurationMs,
      lastRunResult: this.lastRunResult,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      skippedTicks: this.skippedTicks,
      activeRun: this.inFlight !== null,
    };
  }

  // --- internals ---

  private async tick(): Promise<void> {
    if (this.state !== "RUNNING") return;
    if (this.inFlight) {
      this.skippedTicks++;
      await this.safeEmit("release.recovery.supervisor.tick_skipped", {
        workerId: this.deps.workerId,
        skippedTicks: this.skippedTicks,
      });
      return;
    }
    try {
      await this.runGuarded("scheduled");
    } catch {
      // Failure already recorded on status; scheduling continues.
    }
  }

  private runGuarded(trigger: SupervisorTrigger): Promise<RecoveryRunReport> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const startedAt = Date.now();
    this.lastRunAt = startedAt;

    const p = this.executeOnce(trigger, startedAt).finally(() => {
      this.inFlight = null;
      this.lastRunDurationMs = Date.now() - startedAt;
    });
    this.inFlight = p;
    // Attach a no-op handler so the canonical promise is never considered
    // unhandled even if a caller detaches. The real caller still observes
    // the rejection via its own await.
    p.catch(() => {
      /* recorded via status */
    });
    return p;
  }

  private async executeOnce(
    trigger: SupervisorTrigger,
    startedAt: number,
  ): Promise<RecoveryRunReport> {
    await this.safeEmit("release.recovery.supervisor.run_started", {
      workerId: this.deps.workerId,
      trigger,
      startedAt,
    });

    let report: RecoveryRunReport;
    try {
      report = await this.deps.executor.runOnce();
    } catch (e) {
      const msg = ReleaseRecoverySupervisor.normalizeError(e);
      this.lastError = msg;
      this.consecutiveFailures++;
      await this.safeEmit("release.recovery.supervisor.run_failed", {
        workerId: this.deps.workerId,
        trigger,
        durationMs: Date.now() - startedAt,
        error: msg,
        consecutiveFailures: this.consecutiveFailures,
      });
      await this.safeAudit({
        actor: this.deps.workerId,
        action: "release.recovery.supervisor.run_failed",
        resource_type: "release_recovery_supervisor",
        resource_id: this.deps.workerId,
        result: "blocked",
        metadata: {
          trigger,
          error: msg,
          consecutiveFailures: this.consecutiveFailures,
        },
      });
      throw e;
    }

    this.lastRunResult = report;
    this.lastError = null;
    this.consecutiveFailures = 0;
    await this.safeEmit("release.recovery.supervisor.run_completed", {
      workerId: this.deps.workerId,
      trigger,
      durationMs: Date.now() - startedAt,
      scanned: report.scanned,
      acted: report.acted,
      skipped: report.skipped,
      blocked: report.blocked,
      leaseHeld: report.leaseHeld,
    });
    return report;
  }

  /**
   * Normalize an unknown thrown value into a short, safe diagnostic string.
   * Preserves error class name (useful for triage) and message, without
   * dumping arbitrary structured data that might contain credentials.
   */
  private static normalizeError(e: unknown): string {
    let raw: string;
    if (e instanceof Error) {
      const name = e.constructor?.name || "Error";
      raw = `${name}: ${e.message}`;
    } else if (typeof e === "string") {
      raw = e;
    } else {
      return "unknown error";
    }

    // Redact obvious credential / token patterns before any telemetry write.
    let s = raw;
    s = s.replace(
      /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
      "Authorization: Bearer [REDACTED]",
    );
    s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
    s = s.replace(
      /\b(access_token|refresh_token|id_token|token|password|passwd|pwd|api_key|apikey|secret|client_secret)\s*[=:]\s*[^\s,;&"']+/gi,
      "$1=[REDACTED]",
    );
    // URL-style credentials: scheme://user:pass@host
    s = s.replace(
      /([a-z][a-z0-9+.\-]*:\/\/)[^:@\s/]+:[^@\s/]+@/gi,
      "$1[REDACTED]@",
    );

    const MAX = 500;
    if (s.length > MAX) {
      const tail = "...[truncated]";
      s = s.slice(0, MAX - tail.length) + tail;
    }
    return s;
  }

  private async safeEmit(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.svc.events.emit({ type, source: SOURCE, payload });
    } catch {
      // Telemetry failure is isolated; recovery outcome remains authoritative.
    }
  }

  private async safeAudit(input: {
    actor: string;
    action: string;
    resource_type: string;
    resource_id: string;
    result?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.deps.svc.audit.record(input);
    } catch {
      // Telemetry failure is isolated.
    }
  }
}