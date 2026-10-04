// src/core/post-deployment-integrity.ts
//
// Phase 249: Post-Deployment Integrity & Drift Enforcement.
//
// After a deployment succeeds, NEXUS must be able to observe the actual
// deployed state and compare it against the approved release/artifact/digest.
// This module defines the observation boundary and the pure comparison
// function. It has no persistence and no provider of its own — callers
// (ProductionReleaseEnforcementService) inject a real DeploymentObserver.
//
// Precedence: BLOCKED > NOT_EXECUTED > UNKNOWN > DRIFTED > VERIFIED
// Never claim VERIFIED without a real observation.

export type DeploymentIntegrityState =
  | "VERIFIED"
  | "DRIFTED"
  | "UNKNOWN"
  | "BLOCKED"
  | "NOT_EXECUTED";

export interface DeploymentObservation {
  deployment_id: string;
  /** false when the observer/provider itself cannot be reached. */
  available: boolean;
  /** OBSERVED is the only status that permits VERIFIED. */
  status: "OBSERVED" | "NOT_EXECUTED" | "ERROR";
  observed_release_id?: string | null;
  observed_artifact_id?: string | null;
  observed_digest?: string | null;
  observed_provider?: string | null;
  observed_revision?: string | null;
  reason?: string;
  observed_at: string;
}

export interface DeploymentObserver {
  observe(deploymentId: string): Promise<DeploymentObservation>;
}

export interface ExpectedDeploymentIdentity {
  deployment_id: string;
  release_id: string;
  artifact_id: string;
  artifact_digest: string;
  environment?: string;
}

export interface DeploymentIntegrityResult {
  state: DeploymentIntegrityState;
  expected_digest: string | null;
  observed_digest: string | null;
  reasons: string[];
  observed_at: string;
}

export function evaluateDeploymentIntegrity(
  expected: ExpectedDeploymentIdentity,
  observation: DeploymentObservation,
): DeploymentIntegrityResult {
  const expected_digest = expected.artifact_digest ?? null;
  const observed_digest = observation.observed_digest ?? null;
  const reasons: string[] = [];
  const base = { expected_digest, observed_digest, observed_at: observation.observed_at };

  // 1. Observer/provider unavailable -> BLOCKED (never VERIFIED)
  if (!observation.available) {
    return {
      ...base,
      state: "BLOCKED",
      reasons: ["observer unavailable: " + (observation.reason ?? "no reason given")],
    };
  }

  // 2. Observation not executed -> NOT_EXECUTED
  if (observation.status === "NOT_EXECUTED") {
    return {
      ...base,
      state: "NOT_EXECUTED",
      reasons: ["observation not executed: " + (observation.reason ?? "no reason given")],
    };
  }

  // 3. Observation errored -> UNKNOWN (never treated as success)
  if (observation.status === "ERROR") {
    return {
      ...base,
      state: "UNKNOWN",
      reasons: ["observation error: " + (observation.reason ?? "no reason given")],
    };
  }

  // 4. Missing observed identity -> UNKNOWN (fail-closed)
  if (
    observation.observed_digest === undefined ||
    observation.observed_digest === null ||
    observation.observed_release_id === undefined ||
    observation.observed_release_id === null ||
    observation.observed_artifact_id === undefined ||
    observation.observed_artifact_id === null
  ) {
    return {
      ...base,
      state: "UNKNOWN",
      reasons: ["observed deployment identity incomplete"],
    };
  }

  // 5. Field-by-field comparison
  if (observation.observed_release_id !== expected.release_id) {
    reasons.push(
      "release drift: expected=" +
        expected.release_id +
        " observed=" +
        observation.observed_release_id,
    );
  }
  if (observation.observed_artifact_id !== expected.artifact_id) {
    reasons.push(
      "artifact drift: expected=" +
        expected.artifact_id +
        " observed=" +
        observation.observed_artifact_id,
    );
  }
  if (observation.observed_digest !== expected.artifact_digest) {
    reasons.push(
      "digest drift: expected=" +
        expected.artifact_digest +
        " observed=" +
        observation.observed_digest,
    );
  }

  if (reasons.length > 0) {
    return { ...base, state: "DRIFTED", reasons };
  }

  return { ...base, state: "VERIFIED", reasons: ["identity matches expected"] };
}