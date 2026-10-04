// src/core/security-assurance.ts
//
// Phase 247: Continuous Security Assurance.
//
// Determines whether a set of SecurityEvidence items can still authorize a
// specific release target. Reuses the existing SecurityEvidence model — no
// new persistence, no schema change, no parallel architecture.
//
// Assurance precedence (worst-wins):
//   BLOCKED > INVALID > STALE > NOT_EXECUTED > REQUIRES_REVIEW > VALID
//
// Every state transition is deterministic and side-effect free. Callers
// (SecurityReleaseGate, ProductionReleaseDecisionService) consume the state
// and map it to canonical ALLOW / BLOCK / REQUIRE_REVIEW.

import { SecurityEvidence } from "./types";

export type SecurityAssuranceState =
  | "VALID"
  | "STALE"
  | "INVALID"
  | "NOT_EXECUTED"
  | "BLOCKED"
  | "REQUIRES_REVIEW";

export interface AssuranceTarget {
  artifact_digest: string;
  release_id?: string;
  execution_id?: string;
  commit_sha?: string;
}

export interface EvidenceAssurance {
  evidence_id: string;
  scanner: string;
  category: string;
  state: SecurityAssuranceState;
  reason: string;
}

const RANK: Record<SecurityAssuranceState, number> = {
  VALID: 0,
  REQUIRES_REVIEW: 1,
  NOT_EXECUTED: 2,
  STALE: 3,
  INVALID: 4,
  BLOCKED: 5,
};

export function worseState(
  a: SecurityAssuranceState,
  b: SecurityAssuranceState,
): SecurityAssuranceState {
  return RANK[a] >= RANK[b] ? a : b;
}

export function assessEvidenceAssurance(
  evidence: SecurityEvidence,
  target: AssuranceTarget,
  now: number = Date.now(),
): EvidenceAssurance {
  const base = {
    evidence_id: evidence.id,
    scanner: evidence.scanner,
    category: evidence.category,
  };

  // 1. Scanner explicitly BLOCKED -> BLOCKED
  if (evidence.status === "BLOCKED") {
    return { ...base, state: "BLOCKED", reason: "scanner blocked" };
  }

  // 2. Scanner did not run -> NOT_EXECUTED
  if (evidence.status === "NOT_RUN" || evidence.status === "UNKNOWN") {
    return {
      ...base,
      state: "NOT_EXECUTED",
      reason: "status=" + String(evidence.status),
    };
  }

  // 3. Artifact digest mismatch -> INVALID
  if (
    evidence.artifact_digest &&
    target.artifact_digest &&
    evidence.artifact_digest !== target.artifact_digest
  ) {
    return {
      ...base,
      state: "INVALID",
      reason:
        "digest mismatch evidence=" +
        evidence.artifact_digest +
        " target=" +
        target.artifact_digest,
    };
  }

  // 4. Target requires artifact binding, evidence has none -> INVALID
  if (target.artifact_digest && !evidence.artifact_digest) {
    return {
      ...base,
      state: "INVALID",
      reason: "evidence has no artifact_digest binding",
    };
  }

  // 5. Expired evidence -> STALE
  if (evidence.expires_at) {
    const exp = Date.parse(evidence.expires_at);
    if (!Number.isNaN(exp) && exp <= now) {
      return {
        ...base,
        state: "STALE",
        reason: "expired at " + evidence.expires_at,
      };
    }
  }

  // 6. Release id mismatch -> REQUIRE_REVIEW (not BLOCK — release was renamed/retried)
  if (
    evidence.release_id &&
    target.release_id &&
    evidence.release_id !== target.release_id
  ) {
    return {
      ...base,
      state: "REQUIRES_REVIEW",
      reason:
        "release mismatch evidence=" +
        evidence.release_id +
        " target=" +
        target.release_id,
    };
  }

  return { ...base, state: "VALID", reason: "fresh, bound, applicable" };
}

export interface EvidenceSetAssurance {
  overall: SecurityAssuranceState;
  perEvidence: EvidenceAssurance[];
  reasons: string[];
}

export function assessEvidenceSet(
  evidenceList: SecurityEvidence[],
  target: AssuranceTarget,
  now: number = Date.now(),
): EvidenceSetAssurance {
  const perEvidence: EvidenceAssurance[] = [];
  const reasons: string[] = [];
  let overall: SecurityAssuranceState = "VALID";

  for (const ev of evidenceList) {
    const a = assessEvidenceAssurance(ev, target, now);
    perEvidence.push(a);
    overall = worseState(overall, a.state);
    if (a.state !== "VALID") {
      reasons.push(a.category + ":" + a.scanner + " -> " + a.state + " (" + a.reason + ")");
    }
  }

  return { overall, perEvidence, reasons };
}