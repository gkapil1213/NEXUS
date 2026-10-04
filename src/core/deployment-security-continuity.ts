// src/core/deployment-security-continuity.ts
//
// Phase 248: Production Release-to-Deployment Security Continuity.
//
// The authorization record carried by ProductionExecutionAuthorization is not
// sufficient on its own to invoke a real deployment. The immutable deployment
// identity (release, artifact, digest, commit) must still match the currently
// authoritative security state at the moment of deployment.
//
// This module is a pure function. It has no persistence of its own; the caller
// (ProductionReleaseEnforcementService.authorizeExecution) injects the current
// SecurityEvidence list loaded from the authoritative backend and consumes the
// returned decision.
//
// Precedence: BLOCK > REQUIRE_REVIEW > ALLOW
// Never allow an older ALLOW to override newer BLOCK / REQUIRE_REVIEW.

import { SecurityEvidence } from "./types";
import {
  SecurityAssuranceState,
  AssuranceTarget,
  assessEvidenceSet,
} from "./security-assurance";

export type DeploymentContinuityDecision = "ALLOW" | "BLOCK" | "REQUIRE_REVIEW";

export interface DeploymentContinuityInput {
  release_id: string;
  artifact_id: string;
  artifact_digest: string;
  commit_sha: string;
  environment: string;
  execution_id?: string;
  security_decision_id?: string;
  /** Current authoritative evidence set for this execution. */
  evidence: SecurityEvidence[];
  /** Latest canonical decision recorded for this execution, if known. */
  latest_canonical_decision?: "ALLOW" | "BLOCK" | "REQUIRE_REVIEW" | null;
  /**
   * The artifact digest the security decision was originally bound to.
   * If it does not equal the current target digest, deployment is BLOCKed.
   */
  expected_security_decision_digest?: string | null;
  now?: number;
}

export interface DeploymentContinuityResult {
  decision: DeploymentContinuityDecision;
  assurance: SecurityAssuranceState;
  reasons: string[];
}

export function evaluateDeploymentSecurityContinuity(
  input: DeploymentContinuityInput,
): DeploymentContinuityResult {
  const now = input.now ?? Date.now();

  // 1. If the latest canonical decision is not ALLOW, propagate it.
  if (input.latest_canonical_decision === "BLOCK") {
    return {
      decision: "BLOCK",
      assurance: "VALID",
      reasons: ["current canonical decision is BLOCK"],
    };
  }
  if (input.latest_canonical_decision === "REQUIRE_REVIEW") {
    return {
      decision: "REQUIRE_REVIEW",
      assurance: "VALID",
      reasons: ["current canonical decision is REQUIRE_REVIEW"],
    };
  }

  // 2. The security decision's artifact binding must equal the target digest.
  if (
    input.expected_security_decision_digest &&
    input.expected_security_decision_digest !== input.artifact_digest
  ) {
    return {
      decision: "BLOCK",
      assurance: "INVALID",
      reasons: [
        "security decision artifact digest (" +
          input.expected_security_decision_digest +
          ") does not match target digest (" +
          input.artifact_digest +
          ")",
      ],
    };
  }

  // 2b. Fail-closed: no evidence means no authorization, regardless of
  //     canonical decision. Empty evidence is NOT_EXECUTED, not VALID.
  if (input.evidence.length === 0) {
    return {
      decision: "BLOCK",
      assurance: "NOT_EXECUTED",
      reasons: ["no security evidence supplied for deployment continuity"],
    };
  }

  // 3. Phase 247 assurance re-evaluation at deployment time.
  const target: AssuranceTarget = {
    artifact_digest: input.artifact_digest,
    // release_id intentionally omitted: evidence binds to the artifact via
    // cryptographic digest; release labels may vary between candidates.
    execution_id: input.execution_id,
    commit_sha: input.commit_sha,
  };
  const assurance = assessEvidenceSet(input.evidence, target, now);

  if (
    assurance.overall === "BLOCKED" ||
    assurance.overall === "INVALID" ||
    assurance.overall === "STALE" ||
    assurance.overall === "NOT_EXECUTED"
  ) {
    return {
      decision: "BLOCK",
      assurance: assurance.overall,
      reasons:
        assurance.reasons.length > 0
          ? assurance.reasons
          : ["assurance state: " + assurance.overall],
    };
  }
  if (assurance.overall === "REQUIRES_REVIEW") {
    return {
      decision: "REQUIRE_REVIEW",
      assurance: assurance.overall,
      reasons:
        assurance.reasons.length > 0
          ? assurance.reasons
          : ["assurance state: REQUIRE_REVIEW"],
    };
  }

  // 4. Fresh evidence, matching digest, no blocking signals.
  return { decision: "ALLOW", assurance: "VALID", reasons: [] };
}