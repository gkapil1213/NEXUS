// Phase 201: pure eligibility computation for a stage in an execution graph.
//
// The existing StageStatus state machine (PENDING, RUNNING, SUCCEEDED,
// FAILED, SKIPPED, CANCELLED) is preserved unchanged. Readiness / blocked /
// waiting semantics are DERIVED here per scheduler tick, not persisted.
// The caller supplies the current stage graph; this module performs no I/O.

import type { StageExecution, StageStatus } from "./worker-stage-execution";

export type EligibilityReason =
  | "ELIGIBLE"
  | "STAGE_TERMINAL"
  | "STAGE_NOT_PENDING"
  | "DEPENDENCY_NOT_SUCCEEDED"
  | "DEPENDENCY_TERMINAL_FAILURE"
  | "EXECUTION_CANCELLED";

export interface EligibilityInput {
  stage: StageExecution;
  dependencyNames: string[];
  stagesByName: Map<string, StageExecution>;
  executionCancelled: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  missingDependencies?: string[];
  failingDependencies?: string[];
}

const TERMINAL_FAILURE_STATES: readonly StageStatus[] = ["FAILED", "CANCELLED", "SKIPPED"];
const TERMINAL_STATES: readonly StageStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"];

export function isStageEligible(input: EligibilityInput): EligibilityResult {
  if (input.executionCancelled) {
    return { eligible: false, reason: "EXECUTION_CANCELLED" };
  }

  if (TERMINAL_STATES.includes(input.stage.status)) {
    return { eligible: false, reason: "STAGE_TERMINAL" };
  }
  if (input.stage.status !== "PENDING") {
    return { eligible: false, reason: "STAGE_NOT_PENDING" };
  }

  if (input.dependencyNames.length === 0) {
    return { eligible: true, reason: "ELIGIBLE" };
  }

  const missing: string[] = [];
  const failing: string[] = [];

  for (const depName of input.dependencyNames) {
    const dep = input.stagesByName.get(depName);
    if (!dep) { missing.push(depName); continue; }
    if (dep.status === "SUCCEEDED") continue;
    if (TERMINAL_FAILURE_STATES.includes(dep.status)) { failing.push(depName); continue; }
    missing.push(depName);
  }

  if (failing.length > 0) {
    return { eligible: false, reason: "DEPENDENCY_TERMINAL_FAILURE", failingDependencies: failing };
  }
  if (missing.length > 0) {
    return { eligible: false, reason: "DEPENDENCY_NOT_SUCCEEDED", missingDependencies: missing };
  }
  return { eligible: true, reason: "ELIGIBLE" };
}