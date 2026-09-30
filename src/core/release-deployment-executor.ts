// src/core/release-deployment-executor.ts
// Phase 225: thin adapter from RELEASE_READY evidence to the existing
// ReleaseExecutionGate. Does not duplicate gate logic; only translates
// stage-executor inputs into the gate contract.

import type { ReleaseExecutionGate, ReleaseExecutionInput, ReleaseExecutionOutcome } from "./release-execution-gate";
import type { ReleaseCandidate, ReleaseSafetyPolicy } from "./release-safety-gate";
import type { ReleaseIntentInput } from "./release-deployment-intent";
import type { EngineeringReleaseReadyOutcome } from "./engineering-release-ready-executor";

export interface ReleaseDeploymentRequest {
  /** Output of EngineeringReleaseReadyExecutor.run(). Must be SUCCEEDED. */
  releaseReady: EngineeringReleaseReadyOutcome;
  /** Raw Phase 209/210 verification-run JSON. Passed through unchanged. */
  verificationRun: unknown;
  /** Safety policy applied by Phase 210. Caller supplies; no default. */
  policy: ReleaseSafetyPolicy;
  /** Deployment configuration. Same shape the enforcement service expects. */
  intentInput: ReleaseIntentInput;
  /** From ProductionReleaseEnforcementService.requestRelease(). */
  authorizationId: string;
  /** Durable attempt id from the execution store. */
  attemptId: string;
}

export type ReleaseDeploymentBlockReason =
  | "GATE_NOT_AVAILABLE"
  | "RELEASE_READY_NOT_SUCCEEDED"
  | "MISSING_RELEASE_ID"
  | "MISSING_SOURCE_REVISION"
  | "MISSING_ARTIFACT"
  | "SECURITY_REVIEW_NOT_SUCCEEDED";

export interface ReleaseDeploymentResult {
  /** From gate: EXECUTED | REJECTED | BLOCKED | NOT_EXECUTED. */
  status: ReleaseExecutionOutcome["status"];
  /** Non-null when the executor refused before invoking the gate. */
  blockReason: ReleaseDeploymentBlockReason | null;
  /** Full gate outcome when the gate ran; null on early refusal. */
  outcome: ReleaseExecutionOutcome | null;
}

export class ReleaseDeploymentExecutor {
  constructor(private readonly gate: ReleaseExecutionGate | undefined) {}

  async execute(req: ReleaseDeploymentRequest): Promise<ReleaseDeploymentResult> {
    if (!this.gate) {
      return { status: "BLOCKED", blockReason: "GATE_NOT_AVAILABLE", outcome: null };
    }
    if (req.releaseReady.status !== "SUCCEEDED") {
      return { status: "BLOCKED", blockReason: "RELEASE_READY_NOT_SUCCEEDED", outcome: null };
    }
    if (!req.releaseReady.releaseId) {
      return { status: "BLOCKED", blockReason: "MISSING_RELEASE_ID", outcome: null };
    }
    if (!req.releaseReady.sourceRevision) {
      return { status: "BLOCKED", blockReason: "MISSING_SOURCE_REVISION", outcome: null };
    }
    if (!req.releaseReady.candidateArtifactId && !req.releaseReady.candidateArtifactRef) {
      return { status: "BLOCKED", blockReason: "MISSING_ARTIFACT", outcome: null };
    }

    // Phase 225 §17: SECURITY_REVIEW is a mandatory gate. A RELEASE_READY
    // outcome with a non-SUCCEEDED security check must never reach deployment.
    const secCheck = (req.releaseReady.stageChecks ?? []).find(
      (c) => c.stageType === "SECURITY_REVIEW",
    );
    if (!secCheck || secCheck.status !== "SUCCEEDED") {
      return { status: "BLOCKED", blockReason: "SECURITY_REVIEW_NOT_SUCCEEDED", outcome: null };
    }

    const candidate: ReleaseCandidate = {
      releaseId: req.releaseReady.releaseId,
      executionId: req.intentInput.executionId,
      commitSha: req.releaseReady.sourceRevision,
      artifactId: req.releaseReady.candidateArtifactId ?? undefined,
      artifactDigest: req.intentInput.artifactDigest,
      environment: req.intentInput.environment,
    };

    const input: ReleaseExecutionInput = {
      candidate,
      verificationRun: req.verificationRun,
      policy: req.policy,
      intentInput: req.intentInput,
      authorizationId: req.authorizationId,
      attemptId: req.attemptId,
    };

    const outcome = await this.gate.execute(input);
    return { status: outcome.status, blockReason: null, outcome };
  }
}
