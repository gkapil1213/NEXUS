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
    this.state = "STARTING";
    await this.deps.svc.events.emit({
      type: "release.recovery.supervisor.started",
      source: SOURCE,
      payload: { workerId: this.deps.workerId, intervalMs: this.deps.intervalMs },
    });

    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();

    this.startedAt = Date.now();
    this.state = "RUNNING";

    await this.deps.svc.audit.record({
      actor: this.deps.workerId,
      action: "release.recovery.supervisor.start",
      resource_type: "release_recovery_supervisor",
      resource_id: this.deps.workerId,
      result: "ok",
      metadata: { intervalMs: this.deps.intervalMs },
    });
  }

  async stop(options?: { finalPass?: boolean }): Promise<void> {
    if (this.state === "STOPPED" && this.timer === null && this.inFlight === null) {
      return;
    }
    this.state = "STOPPING";

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // inFlight never rejects by construction
      }
    }

    if (options?.finalPass) {
      await this.runGuarded("final");
    }

    this.startedAt = null;
    this.state = "STOPPED";

    await this.deps.svc.events.emit({
      type: "release.recovery.supervisor.stopped",
      source: SOURCE,
      payload: { workerId: this.deps.workerId, finalPass: !!options?.finalPass },
    });
    await this.deps.svc.audit.record({
      actor: this.deps.workerId,
      action: "release.recovery.supervisor.stop",
      resource_type: "release_recovery_supervisor",
      resource_id: this.deps.workerId,
      result: "ok",
      metadata: { finalPass: !!options?.finalPass },
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

  private async tick(): Promise<void> {
    if (this.state !== "RUNNING") return;
    if (this.inFlight) {
      this.skippedTicks++;
      await this.deps.svc.events.emit({
        type: "release.recovery.supervisor.tick_skipped",
        source: SOURCE,
        payload: {
          workerId: this.deps.workerId,
          skippedTicks: this.skippedTicks,
        },
      });
      return;
    }
    await this.runGuarded("scheduled");
  }

  private async runGuarded(trigger: "scheduled" | "manual" | "final"): Promise<RecoveryRunReport> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const startedAt = Date.now();
    this.lastRunAt = startedAt;

    await this.deps.svc.events.emit({
      type: "release.recovery.supervisor.run_started",
      source: SOURCE,
      payload: { workerId: this.deps.workerId, trigger, startedAt },
    });

    const promise = (async () => {
      try {
        const report = await this.deps.executor.runOnce();
        this.lastRunResult = report;
        this.lastError = null;
        this.consecutiveFailures = 0;
        return report;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.lastError = message;
        this.consecutiveFailures++;
        throw e;
      }
    })();

    this.inFlight = promise.finally(() => {
      this.lastRunDurationMs = Date.now() - startedAt;
      this.inFlight = null;
    });

    try {
      const report = await promise;
      await this.deps.svc.events.emit({
        type: "release.recovery.supervisor.run_completed",
        source: SOURCE,
        payload: {
          workerId: this.deps.workerId,
          trigger,
          durationMs: this.lastRunDurationMs,
          scanned: report.scanned,
          acted: report.acted,
          skipped: report.skipped,
          blocked: report.blocked,
          leaseHeld: report.leaseHeld,
        },
      });
      return report;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.deps.svc.events.emit({
        type: "release.recovery.supervisor.run_failed",
        source: SOURCE,
        payload: {
          workerId: this.deps.workerId,
          trigger,
          durationMs: this.lastRunDurationMs,
          error: message,
          consecutiveFailures: this.consecutiveFailures,
        },
      });
      await this.deps.svc.audit.record({
        actor: this.deps.workerId,
        action: "release.recovery.supervisor.run_failed",
        resource_type: "release_recovery_supervisor",
        resource_id: this.deps.workerId,
        result: "blocked",
        metadata: { trigger, error: message, consecutiveFailures: this.consecutiveFailures },
      });
      throw e;
    }
  }
}