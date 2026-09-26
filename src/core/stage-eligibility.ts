// Phase 201: pure eligibility computation for a stage in an execution graph.
//
// The existing StageStatus state machine (PENDING, RUNNING, SUCCEEDED,
// FAILED, SKIPPED, CANCELLED) is preserved unchanged. Readiness / blocked /
// waiting semantics are DERIVED here per scheduler tick, not persisted.
// The caller supplies the current stage graph; this module performs no I/O.

import type { StageExecution, StageStatus } from "./worker-stage-execution";

export type EligibilityReason =
  | "ELIGIBLE"
  | "STAGE_NOT_FOUND"
  | "STAGE_TERMINAL"
  | "STAGE_NOT_PENDING"
  | "DEPENDENCY_NOT_SUCCEEDED"
  | "DEPENDENCY_IN_FLIGHT"
  | "DEPENDENCY_RETRY_PENDING"
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
  inFlightDependencies?: string[];
  retryPendingDependencies?: string[];
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
  const inFlight: string[] = [];
  const retryPending: string[] = [];

  for (const depName of input.dependencyNames) {
    const dep = input.stagesByName.get(depName);
    if (!dep) { missing.push(depName); continue; }
    if (dep.status === "SUCCEEDED") continue;

    // Phase 202b: read the durable underlying job status when available.
    // StageStatus collapses RETRY_SCHEDULED/DEAD_LETTER into FAILED, so we
    // consult derivedJobStatus to distinguish transient states from terminal.
    const dj = dep.derivedJobStatus;
    if (dj === "RETRY_SCHEDULED") { retryPending.push(depName); continue; }
    if (dj === "RUNNING" || dj === "CLAIMED" || dj === "VERIFYING" || dj === "ADMITTED") {
      inFlight.push(depName);
      continue;
    }

    if (TERMINAL_FAILURE_STATES.includes(dep.status)) { failing.push(depName); continue; }
    missing.push(depName);
  }

  if (failing.length > 0) {
    return { eligible: false, reason: "DEPENDENCY_TERMINAL_FAILURE", failingDependencies: failing };
  }
  if (retryPending.length > 0) {
    return { eligible: false, reason: "DEPENDENCY_RETRY_PENDING", retryPendingDependencies: retryPending };
  }
  if (inFlight.length > 0) {
    return { eligible: false, reason: "DEPENDENCY_IN_FLIGHT", inFlightDependencies: inFlight };
  }
  if (missing.length > 0) {
    return { eligible: false, reason: "DEPENDENCY_NOT_SUCCEEDED", missingDependencies: missing };
  }
  return { eligible: true, reason: "ELIGIBLE" };
}