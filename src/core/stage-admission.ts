// Phase 202a: durable runtime admission decision.
//
// isStageEligible() is a pure function; it expects the caller to supply
// the graph and stage map. evaluateStageAdmission() reads those from the
// durable store so workers can consult admission without any in-memory
// state. No new dependency model is introduced; the canonical Phase 201
// table and StageExecutionStoreAdapter are the source of truth.

import type { ExecutionStore } from "./execution-store";
import { StageExecutionStoreAdapter } from "./stage-execution-store-adapter";
import { isStageEligible, type EligibilityResult } from "./stage-eligibility";
import type { StageExecution } from "./worker-stage-execution";

export interface StageAdmissionContext {
  store: ExecutionStore;
  executionId: string;
  stageName: string;
}

/**
 * Read the canonical dependency graph and stage states for `executionId`
 * from durable storage and return the admission decision for `stageName`.
 *
 * Deterministic for a given durable state: repeated calls with no
 * intervening writes return the same result. No caching; no reliance on
 * caller-supplied maps.
 */
export function evaluateStageAdmission(ctx: StageAdmissionContext): EligibilityResult {
  const { store, executionId, stageName } = ctx;

  // 1. Execution-level cancellation is read from the pipeline job itself.
  const execJob = store.getJob(executionId);
  const executionCancelled = Boolean(execJob?.cancellationRequested);

  // 2. Load every stage in this execution from durable storage.
  const adapter = new StageExecutionStoreAdapter(store);
  const allStages: StageExecution[] = adapter.listForExecutionSync(executionId);

  const stagesByName = new Map<string, StageExecution>();
  for (const s of allStages) stagesByName.set(s.stageName, s);

  // 3. Target stage must exist in the durable store.
  const target = stagesByName.get(stageName);
  if (!target) {
    return { eligible: false, reason: "STAGE_NOT_FOUND" };
  }

  // 4. Canonical Phase 201 dependency edges.
  const depNames = store.stageDeps.getDependencies(executionId, stageName);

  // 5. Delegate the decision to the pure eligibility function.
  return isStageEligible({
    stage: target,
    dependencyNames: depNames,
    stagesByName,
    executionCancelled,
  });
}