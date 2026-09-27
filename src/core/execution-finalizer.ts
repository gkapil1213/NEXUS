// Phase 204: durable execution lifecycle finalization.
//
// The Phase 203 driver converges individual stage jobs but never
// transitions the parent pipeline job out of RUNNING. This module
// computes the aggregate outcome from durable stage rows and performs
// the parent transition via the same CAS primitive used by recovery,
// so concurrent finalizers cannot double-transition.

import type { ExecutionStore } from "./execution-store";
import type { ExecutionJobStatus } from "./execution-models";
import { StageExecutionStoreAdapter } from "./stage-execution-store-adapter";

export type AggregateOutcome =
  | { outcome: "RUNNING"; reason: string }
  | { outcome: "SUCCEEDED"; reason: string }
  | { outcome: "FAILED"; reason: string }
  | { outcome: "CANCELLED"; reason: string };

const STAGE_TERMINAL: readonly string[] = ["SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"];
const STAGE_TERMINAL_FAILURE: readonly string[] = ["FAILED", "CANCELLED", "SKIPPED"];

/**
 * Compute the aggregate outcome of the parent execution from its stages.
 * Pure read. Deterministic for a given durable state.
 */
export function computeExecutionOutcome(
  store: ExecutionStore,
  executionId: string,
): AggregateOutcome {
  const execJob = store.getJob(executionId);
  if (!execJob) return { outcome: "FAILED", reason: "EXECUTION_NOT_FOUND" };

  if (execJob.cancellationRequested) {
    return { outcome: "CANCELLED", reason: "CANCELLATION_REQUESTED" };
  }

  const adapter = new StageExecutionStoreAdapter(store);
  const stages = adapter.listForExecutionSync(executionId);
  if (stages.length === 0) {
    return { outcome: "RUNNING", reason: "NO_STAGES" };
  }

  // Any CANCELLED stage ? parent CANCELLED (cancellation propagates up).
  if (stages.some((s) => s.status === "CANCELLED")) {
    return { outcome: "CANCELLED", reason: "STAGE_CANCELLED" };
  }

  // Any terminal stage failure ? parent FAILED.
  if (stages.some((s) => STAGE_TERMINAL_FAILURE.includes(s.status))) {
    return { outcome: "FAILED", reason: "STAGE_TERMINAL_FAILURE" };
  }

  // All stages SUCCEEDED ? parent SUCCEEDED.
  if (stages.every((s) => s.status === "SUCCEEDED")) {
    return { outcome: "SUCCEEDED", reason: "ALL_STAGES_SUCCEEDED" };
  }

  // Otherwise still in flight.
  const pending = stages.filter((s) => !STAGE_TERMINAL.includes(s.status));
  return { outcome: "RUNNING", reason: "STAGES_IN_FLIGHT:" + pending.length };
}

export interface FinalizeResult {
  ok: boolean;
  applied: boolean;
  status?: ExecutionJobStatus;
  reason: string;
}

/**
 * Finalize the parent execution if its stages have converged.
 * Idempotent and concurrency-safe: uses recoverJobAtomic which performs a
 * CAS on (id, expectedStatus, expectedLeaseId) — the same primitive used
 * for recovery transitions.
 */
export function finalizeExecution(
  store: ExecutionStore,
  executionId: string,
  now: number = Date.now(),
): FinalizeResult {
  const execJob = store.getJob(executionId);
  if (!execJob) return { ok: false, applied: false, reason: "EXECUTION_NOT_FOUND" };

  const terminal: ExecutionJobStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER", "BLOCKED"];
  if (terminal.includes(execJob.status)) {
    return { ok: true, applied: false, status: execJob.status, reason: "ALREADY_TERMINAL" };
  }

  const agg = computeExecutionOutcome(store, executionId);
  if (agg.outcome === "RUNNING") {
    return { ok: true, applied: false, reason: agg.reason };
  }

  const cas = store.recoverJobAtomic({
    jobId: executionId,
    expectedStatus: execJob.status,
    newStatus: agg.outcome,
    expectedLeaseId: null,
    patch: {} as any,
    event: {
      eventType: "execution.lifecycle.finalized",
      payload: {
        executionId,
        from: execJob.status,
        to: agg.outcome,
        reason: agg.reason,
        at: now,
      },
    },
  });

  if (!cas.ok) {
    // Another writer already transitioned the pipeline.
    const fresh = store.getJob(executionId);
    if (fresh && terminal.includes(fresh.status)) {
      return { ok: true, applied: false, status: fresh.status, reason: "CAS_LOST_ALREADY_TERMINAL" };
    }
    return { ok: false, applied: false, reason: "CAS_LOST" };
  }

  return { ok: true, applied: true, status: agg.outcome, reason: agg.reason };
}