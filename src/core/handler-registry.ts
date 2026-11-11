// Phase 292: extracted handler registry for worker gateway message types.
// Per design decision 2: each handler declares replayEligible. Recovery
// consults this flag before automatically re-invoking a handler.
//
// Handlers receive a HandlerContext with all dependencies already wired.
// The request path and the recovery path both invoke handlers through this
// registry, ensuring a single source of truth for handler behavior.

import { RemoteWorkerStore } from "./remote-worker-store";
import { ExecutionStore } from "./execution-store";
import type { DispatchService } from "./dispatch-service";
import { sha256Hex, computeResultDigest } from "./integrity";
import { RemoteExecutionResult, RemoteDispatchRecord } from "./execution-models";

export interface HandlerContext {
  workerId: string;
  payload: any;
  workerStore: RemoteWorkerStore;
  executionStore?: ExecutionStore;
  dispatchService?: DispatchService;
}

export type Handler = (ctx: HandlerContext) => Promise<any>;

export interface HandlerRegistration {
  handler: Handler;
  replayEligible: boolean;
  reason: string;
}

export class HandlerRegistry {
  private handlers = new Map<string, HandlerRegistration>();

  register(type: string, reg: HandlerRegistration): void {
    if (this.handlers.has(type)) {
      throw new Error(`handler_already_registered:${type}`);
    }
    this.handlers.set(type, reg);
  }

  get(type: string): HandlerRegistration | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  isReplayEligible(type: string): boolean {
    return this.handlers.get(type)?.replayEligible === true;
  }

  types(): string[] {
    return Array.from(this.handlers.keys());
  }
}

// ------------------------------------------------------------------
// Individual handler implementations (extracted from worker-gateway.ts switch)
// ------------------------------------------------------------------

async function heartbeatHandler(ctx: HandlerContext): Promise<any> {
  const worker = ctx.workerStore.getWorker(ctx.workerId);
  if (!worker) throw new Error("worker_not_found");
  worker.lastHeartbeatAt = Date.now();
  worker.status = ctx.payload?.currentJobId ? "BUSY" : "ONLINE";
  ctx.workerStore.updateWorker(worker);
  return { type: "HEARTBEAT_ACK" };
}

async function jobOfferHandler(ctx: HandlerContext): Promise<any> {
  if (!ctx.executionStore) throw new Error("durable_store_unavailable");
  const claimed = ctx.executionStore.claimNextDispatchForWorker(ctx.workerId);
  if (!claimed) return { type: "JOB_OFFER", job: null };
  return {
    type: "JOB_OFFER",
    job: {
      jobId: claimed.jobId,
      dispatchId: claimed.dispatchId,
      leaseId: claimed.leaseId,
      operation: claimed.request?.operation,
      args: claimed.request?.args,
      cwd: claimed.request?.cwd,
      timeoutMs: claimed.request?.timeoutMs,
    },
  };
}

async function jobResultHandler(ctx: HandlerContext): Promise<any> {
  const { jobId, result } = ctx.payload;
  if (!ctx.executionStore) throw new Error("durable_store_unavailable");
  // Phase 300 / WP4: same routing as the gateway preflight. Shared mode
  // uses the async siblings; SQLite-only mode keeps the sync path.
  const dispatch = ctx.executionStore.hasAsyncBackend()
    ? await ctx.executionStore.getRemoteDispatchAsync(result.dispatchId)
    : ctx.executionStore.getRemoteDispatch(result.dispatchId);
  if (!dispatch || dispatch.workerId !== ctx.workerId || dispatch.jobId !== jobId) {
    throw new Error("dispatch_ownership_violation");
  }
  const existing = ctx.executionStore.hasAsyncBackend()
    ? await ctx.executionStore.getRemoteExecutionResultByDispatchIdAsync(result.dispatchId)
    : ctx.executionStore.getRemoteExecutionResultByDispatchId(result.dispatchId);
  if (existing) {
    if (existing.resultSha256 === result.resultSha256) {
      return { type: "JOB_RESULT_ACK" };
    }
    throw new Error("conflicting_duplicate_result");
  }

  const durableResult: RemoteExecutionResult = {
    resultId: `result_${result.dispatchId}`,
    jobId: result.jobId,
    attemptId: dispatch.attemptId,
    workerId: result.workerId || ctx.workerId,
    dispatchId: result.dispatchId,
    leaseId: result.leaseId,
    success: result.success,
    exitCode: result.exitCode,
    stdoutRef: result.stdout,
    stderrRef: result.stderr,
    evidence: result.evidence,
    createdAt: Date.now(),
    stdoutSha256: result.stdoutSha256,
    stderrSha256: result.stderrSha256,
    resultSha256: result.resultSha256,
  };
  const updatedDispatch: RemoteDispatchRecord = {
    ...dispatch,
    result: {
      success: result.success,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      evidence: result.evidence,
    },
    status: result.success ? "COMPLETED" : "FAILED",
    updatedAt: Date.now(),
  };

  // Phase 300 / WP3+WP4: shared mode routes the durable write through the
  // async, transaction-wrapped sibling so the result INSERT and dispatch
  // UPDATE commit atomically against PostgreSQL. SQLite-only mode keeps the
  // existing sync path unchanged.
  let persist: {
    persisted: boolean;
    duplicate?: boolean;
    deduplicated?: boolean;
    reason?: string;
  };
  if (ctx.executionStore.hasAsyncBackend()) {
    persist = await ctx.executionStore.persistRemoteExecutionResultAndDispatchAsOwnerAsync(
      durableResult,
      updatedDispatch,
      result.leaseId,
      result.workerId || ctx.workerId,
    );
  } else {
    persist = ctx.executionStore.persistRemoteExecutionResultAndDispatchAsOwner(
      durableResult,
      updatedDispatch,
      result.leaseId,
      result.workerId || ctx.workerId,
    );
  }
  // deduplicated:true means a concurrent writer landed the same result while
  // this call was in flight. That is a valid ACK (spec: "Identical previously
  // persisted result: ACK"), not an ownership loss.
  if (!persist.persisted) {
    if (persist.reason === "RESULT_CONFLICT") throw new Error("conflicting_duplicate_result");
    if (persist.reason === "DISPATCH_TERMINAL") throw new Error("dispatch_terminal");
    throw new Error("ownership_lost");
  }
  return { type: "JOB_RESULT_ACK" };
}

async function jobCancelHandler(ctx: HandlerContext): Promise<any> {
  const { jobId } = ctx.payload;
  if (!ctx.executionStore) throw new Error("durable_store_unavailable");
  if (!jobId) throw new Error("jobId_required");

  const dispatches = ctx.executionStore.listRemoteDispatchesByJob(jobId);
  const active = dispatches.find(
    (d) => d.workerId === ctx.workerId &&
      (d.status === "DISPATCHED" || d.status === "DISPATCH_INTENT"),
  );

  if (!active) {
    const anyMine = dispatches.find((d) => d.workerId === ctx.workerId);
    if (!anyMine) throw new Error("dispatch_not_found");
    if (anyMine.status === "CANCELLED") {
      return { type: "JOB_CANCEL_ACK" };
    }
    return { type: "JOB_CANCEL_ACK", confirmed: false, reason: "not_cancellable:" + anyMine.status };
  }

  if (!ctx.dispatchService) {
    return { type: "JOB_CANCEL_ACK", confirmed: false, reason: "no_provider_cancel_available" };
  }

  const result = await ctx.dispatchService.cancelDetailed(active.dispatchId);
  if (result.cancelled) {
    return { type: "JOB_CANCEL_ACK" };
  }
  return { type: "JOB_CANCEL_ACK", confirmed: false, reason: result.reason ?? "cancellation_unconfirmed" };
}

// ------------------------------------------------------------------
// Default registry — the 4 worker gateway handlers with eligibility flags
// ------------------------------------------------------------------

export function buildDefaultHandlerRegistry(): HandlerRegistry {
  const r = new HandlerRegistry();
  // HEARTBEAT is idempotent: set-based update. Safe to replay.
  r.register("HEARTBEAT", {
    handler: heartbeatHandler,
    replayEligible: true,
    reason: "idempotent_set_based_update",
  });
  // JOB_OFFER is NOT replay-eligible: claim consumes a dispatch; replaying
  // would claim a different dispatch and lose the original offer.
  r.register("JOB_OFFER", {
    handler: jobOfferHandler,
    replayEligible: false,
    reason: "claim_consumes_dispatch",
  });
  // JOB_RESULT is idempotent: getRemoteExecutionResultByDispatchId returns
  // ACK on duplicate. Safe to replay.
  r.register("JOB_RESULT", {
    handler: jobResultHandler,
    replayEligible: true,
    reason: "idempotent_via_result_dedup",
  });
  // JOB_CANCEL is NOT replay-eligible: external side effect via dispatchService.
  // Per design decision 3, uncertain external outcomes must be quarantined.
  r.register("JOB_CANCEL", {
    handler: jobCancelHandler,
    replayEligible: false,
    reason: "external_side_effect",
  });
  return r;
}