// Phase 205: per-execution reconciliation.
//
// Composes the existing recovery primitives into one deterministic
// operation. Reads durable state, fences stale attempts scoped to this
// execution, advances any dispatchable stage work via the 203a driver,
// and delegates terminal lifecycle decisions to the Phase 204 finalizer.
// Reuses — no new persistence, no new state machine, no new event system.

import type { ExecutionStore } from "./execution-store";
import type { LeaseManager } from "./lease-manager";
import type { ExecutionAdapter } from "./execution-adapter";
import type { ExecutionJobStatus } from "./execution-models";
import { StageExecutionStoreAdapter } from "./stage-execution-store-adapter";
import { runStageGraphToCompletion } from "./stage-dispatch-driver";
import { finalizeExecution, type FinalizeResult } from "./execution-finalizer";

export interface ReconcileInput {
  store: ExecutionStore;
  leaseManager: LeaseManager;
  adapter: ExecutionAdapter;
  executionId: string;
  workerId: string;
  leaseTtlMs?: number;
  staleAttemptMs?: number;
  heartbeatTimeoutMs?: number;
  maxTicks?: number;
  now?: () => number;
}

export type ReconcileAction =
  | "NOOP_TERMINAL"
  | "NOOP_RUNNING"
  | "FENCED"
  | "ADVANCED"
  | "FENCED_AND_ADVANCED";

export interface ReconcileResult {
  executionId: string;
  action: ReconcileAction;
  preStatus: ExecutionJobStatus;
  postStatus: ExecutionJobStatus;
  staleFencedAttempts: string[];
  retryPendingStages: string[];
  dispatched: string[];
  failed: Array<{ stage: string; error: string }>;
  blocked: Array<{ stage: string; reason: string }>;
  finalized: FinalizeResult | null;
  reason: string;
}

const TERMINAL_PARENT: readonly ExecutionJobStatus[] = [
  "SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER", "BLOCKED",
];

const DEFAULT_STALE_ATTEMPT_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * Reconcile a single execution. Deterministic for a given durable state.
 * Idempotent: repeated calls with no intervening progress return
 * NOOP_TERMINAL or NOOP_RUNNING without duplicate side effects.
 */
export async function reconcileExecution(input: ReconcileInput): Promise<ReconcileResult> {
  const nowFn = input.now ?? (() => Date.now());
  const now = nowFn();
  const {
    store, leaseManager, adapter, executionId, workerId,
    leaseTtlMs = 60_000,
    staleAttemptMs = DEFAULT_STALE_ATTEMPT_MS,
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    maxTicks = 200,
  } = input;

  const empty = {
    staleFencedAttempts: [] as string[],
    retryPendingStages: [] as string[],
    dispatched: [] as string[],
    failed: [] as Array<{ stage: string; error: string }>,
    blocked: [] as Array<{ stage: string; reason: string }>,
    finalized: null as FinalizeResult | null,
  };

  const pre = store.getJob(executionId);
  if (!pre) {
    return {
      executionId,
      action: "NOOP_TERMINAL",
      preStatus: "FAILED" as ExecutionJobStatus,
      postStatus: "FAILED" as ExecutionJobStatus,
      ...empty,
      reason: "EXECUTION_NOT_FOUND",
    };
  }

  if (TERMINAL_PARENT.includes(pre.status)) {
    return {
      executionId,
      action: "NOOP_TERMINAL",
      preStatus: pre.status,
      postStatus: pre.status,
      ...empty,
      reason: "ALREADY_TERMINAL",
    };
  }

  // 1. Fence stale attempts scoped to this execution's stages.
  const port = new StageExecutionStoreAdapter(store);
  const stages = port.listForExecutionSync(executionId);
  const stageIds = new Set(stages.map((s) => s.stageExecutionId));

  const stale = store.listStaleAttempts(now, staleAttemptMs)
    .filter((a) => stageIds.has(a.jobId));

  const staleFencedAttempts: string[] = [];
  for (const a of stale) {
    try {
      const r = store.fenceStaleAttempt({
        attemptId: a.attemptId,
        jobId: a.jobId,
        leaseId: a.leaseId,
        reason: "HEARTBEAT_TIMEOUT",
        now,
        mode: "heartbeat",
        staleCutoffMs: staleAttemptMs,
        heartbeatFreshMs: heartbeatTimeoutMs,
      });
      if (r.fenced) staleFencedAttempts.push(a.attemptId);
    } catch { /* isolated: one fence failure does not abort reconciliation */ }
  }

  // 2. Record retry-pending stages (informational — finalizer is what
  //    actually keeps the parent non-terminal for these).
  const retryPendingStages = stages
    .filter((s) => s.derivedJobStatus === "RETRY_SCHEDULED")
    .map((s) => s.stageName);

  // 3. Advance any dispatchable stage work via the 203a driver.
  let dispatched: string[] = [];
  let failed: Array<{ stage: string; error: string }> = [];
  let blocked: Array<{ stage: string; reason: string }> = [];
  try {
    const sum = await runStageGraphToCompletion({
      store, leaseManager, adapter,
      executionId, workerId, leaseTtlMs, maxTicks, now: nowFn,
    });
    dispatched = sum.dispatched;
    failed = sum.failed;
    blocked = sum.blocked;
  } catch { /* isolated: driver throw; finalizer still runs below */ }

  // 4. Delegate terminal decision to the Phase 204 finalizer.
  let finalized: FinalizeResult | null = null;
  try {
    finalized = finalizeExecution(store, executionId, now);
  } catch { /* isolated: finalize failure is surfaced via postStatus */ }

  const post = store.getJob(executionId);
  const postStatus = post?.status ?? pre.status;

  let action: ReconcileAction = "NOOP_RUNNING";
  if (staleFencedAttempts.length > 0 && dispatched.length > 0) action = "FENCED_AND_ADVANCED";
  else if (staleFencedAttempts.length > 0) action = "FENCED";
  else if (dispatched.length > 0) action = "ADVANCED";
  else if (finalized?.applied) action = "ADVANCED";

  return {
    executionId,
    action,
    preStatus: pre.status,
    postStatus,
    staleFencedAttempts,
    retryPendingStages,
    dispatched,
    failed,
    blocked,
    finalized,
    reason: finalized?.reason ?? "NO_TRANSITION",
  };
}

/**
 * Enumerate parent pipeline executions that are non-terminal. Callers
 * can then invoke reconcileExecution on each.
 */
export function listExecutionsNeedingReconciliation(store: ExecutionStore): string[] {
  const running = store.listJobsByStatus("RUNNING");
  const cancelling = store.listJobsByStatus("CANCELLATION_REQUESTED");
  const parents = [...running, ...cancelling].filter(
    (j) => (j as any).jobType === "pipeline" || (j as any).job_type === "pipeline",
  );
  return parents.map((j) => j.id);
}