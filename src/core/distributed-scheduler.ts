// src/core/distributed-scheduler.ts
// Phase 185: distributed scheduler and admission control.
//
// Coordination is entirely in PostgreSQL:
//   - pg_advisory_xact_lock in ExecutionStore.admitNextJobAsync serializes
//     admissions globally across processes.
//   - Status CAS (WHERE status = ...) fences concurrent cancellations/claims.
//   - Retry promotion is one atomic UPDATE with status='RETRY_SCHEDULED' filter,
//     so concurrent promoters see 0 rows after the winner commits.
//   - Stale ADMITTED jobs are reverted to QUEUED after a TTL, so a scheduler
//     crash cannot leak capacity permanently.
//
// This class holds no in-memory coordination state. ownerId is a label used
// for auditing -- it is not a source of truth. Multiple DistributedScheduler
// instances in different processes are safe by construction.

import { ExecutionStore } from "./execution-store";

export interface SchedulerTickReport {
  expiredStaleAdmissions: number;
  retriesPromoted: number;
  jobsAdmitted: number;
  capacityDeferred: number;
  admissionOwner: string;
  tickEpoch: number;
  jobsDispatched: number;
  dispatchesDeferred: number;
}

export interface SchedulerConfig {
  /** Global concurrency limit (ADMITTED + CLAIMED + RUNNING + VERIFYING + CANCELLATION_REQUESTED). */
  maxConcurrency: number;
  /** Max jobs admitted per tick() call. Bounds per-tick work. */
  maxAdmissionsPerTick: number;
  /** Anti-starvation aging interval in ms. Larger = slower aging. */
  agingMs: number;
  /** TTL for stale ADMITTED jobs before they revert to QUEUED. */
  admissionTtlMs: number;
  maxDispatchesPerTick: number;
  maxConcurrencyPerWorker: number;
  dispatchLeaseDurationMs: number;
}

const DEFAULTS: SchedulerConfig = {
  maxConcurrency: 4,
  maxAdmissionsPerTick: 16,
  agingMs: 60_000,
  admissionTtlMs: 60_000,
  maxDispatchesPerTick: 16,
  maxConcurrencyPerWorker: 1,
  dispatchLeaseDurationMs: 60_000,
};

function resolveConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    maxConcurrency: overrides.maxConcurrency ?? Number(process.env.NEXUS_SCHEDULER_MAX_CONCURRENCY ?? DEFAULTS.maxConcurrency),
    maxAdmissionsPerTick: overrides.maxAdmissionsPerTick ?? Number(process.env.NEXUS_SCHEDULER_MAX_PER_TICK ?? DEFAULTS.maxAdmissionsPerTick),
    agingMs: overrides.agingMs ?? Number(process.env.NEXUS_SCHEDULER_AGING_MS ?? DEFAULTS.agingMs),
    admissionTtlMs: overrides.admissionTtlMs ?? Number(process.env.NEXUS_SCHEDULER_ADMISSION_TTL_MS ?? DEFAULTS.admissionTtlMs),
    maxDispatchesPerTick: overrides.maxDispatchesPerTick ?? Number(process.env.NEXUS_SCHEDULER_MAX_DISPATCHES_PER_TICK ?? DEFAULTS.maxDispatchesPerTick),
    maxConcurrencyPerWorker: overrides.maxConcurrencyPerWorker ?? Number(process.env.NEXUS_SCHEDULER_WORKER_CONCURRENCY ?? DEFAULTS.maxConcurrencyPerWorker),
    dispatchLeaseDurationMs: overrides.dispatchLeaseDurationMs ?? Number(process.env.NEXUS_SCHEDULER_DISPATCH_LEASE_MS ?? DEFAULTS.dispatchLeaseDurationMs),
  };
}

export class DistributedScheduler {
  private readonly config: SchedulerConfig;
  readonly ownerId: string;

  constructor(
    private readonly store: ExecutionStore,
    overrides: Partial<SchedulerConfig> = {},
    ownerId?: string,
  ) {
    this.config = resolveConfig(overrides);
    this.ownerId = ownerId ?? `scheduler-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  }

  getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  /**
   * Runs one scheduling pass. Safe to call concurrently from N processes.
   *
   * Order is important:
   *   1. Recover stale ADMITTED jobs (frees capacity that crashed schedulers leaked).
   *   2. Promote due retries to QUEUED (makes them eligible for admission).
   *   3. Admit up to maxAdmissionsPerTick jobs, respecting global capacity.
   *
   * Every step is bounded and every DB write is a single atomic statement.
   * The function never depends on caller-side state.
   */
  async tick(now: number = Date.now()): Promise<SchedulerTickReport> {
    if (!this.store.hasAsyncBackend()) {
      throw new Error("DistributedScheduler requires shared mode (store.hasAsyncBackend() === false)");
    }

    // Step 1: revert ADMITTED jobs whose admission is stale.
    const expiredStaleAdmissions = await this.store.expireStaleAdmissionsAsync(now, this.config.admissionTtlMs);

    // Step 2: promote RETRY_SCHEDULED -> QUEUED if next_attempt_at <= now.
    const retriesPromoted = await this.store.promoteDueRetriesAsync(now);

    // Step 3: admit jobs until capacity or backlog are exhausted.
    let jobsAdmitted = 0;
    let capacityDeferred = 0;

    while (jobsAdmitted < this.config.maxAdmissionsPerTick) {
      const r = await this.store.admitNextJobAsync({
        owner: this.ownerId,
        capacityLimit: this.config.maxConcurrency,
        agingMs: this.config.agingMs,
        now,
      });

      if (r.admitted) {
        jobsAdmitted++;
        continue;
      }

      if (r.reason === "CAPACITY_EXHAUSTED") {
        capacityDeferred++;
      }
      // Either way we stop -- either capacity is full or no eligible jobs remain.
      break;
    }

    const dispatchReport = await this.dispatchTick(now);

    return {
      expiredStaleAdmissions,
      retriesPromoted,
      jobsAdmitted,
      capacityDeferred,
      admissionOwner: this.ownerId,
      tickEpoch: now,
      jobsDispatched: dispatchReport.jobsDispatched,
      dispatchesDeferred: dispatchReport.dispatchesDeferred,
    };
  }


  async dispatchTick(now: number = Date.now()): Promise<{
    jobsDispatched: number;
    dispatchesDeferred: number;
    admissionOwner: string;
  }> {
    if (!this.store.hasAsyncBackend()) throw new Error("requires shared mode");
    const admitted = await this.store.listJobsByStatusAsync("ADMITTED");
    let jobsDispatched = 0;
    let dispatchesDeferred = 0;
    for (const job of admitted) {
      if (jobsDispatched >= this.config.maxDispatchesPerTick) break;
      if (job.cancellationRequested) continue;
      const r = await this.store.dispatchAdmittedJobAsync({ jobId: job.id, maxConcurrencyPerWorker: this.config.maxConcurrencyPerWorker, leaseDurationMs: this.config.dispatchLeaseDurationMs, now });
      if (r.dispatched) jobsDispatched++;
      else if (r.reason === "WORKER_NOT_FOUND" || r.reason === "WORKER_AT_CAPACITY" || r.reason === "WORKER_NOT_ELIGIBLE") dispatchesDeferred++;
    }
    return { jobsDispatched, dispatchesDeferred, admissionOwner: this.ownerId };
  }

}