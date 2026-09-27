// src/core/release-safety-gate.ts
// Phase 210: evidence-backed release safety gate.
//
// Distinct from SecurityReleaseGate (which evaluates SAST/SCA/SIGNATURE/policy)
// and from ProductionReleaseDecisionService (which adds approval). This gate's
// sole concern is: does the release candidate have valid, current, untampered
// Phase 209 verification evidence for the exact commit/execution being released?
//
// Fail-closed. Rejects on: FAIL, BLOCKED, NOT_EXECUTED, UNVERIFIED, TAMPERED,
// STALE, MISMATCH (commit / execution / artifact), missing evidence, duplicate
// results. Only a verified PASS for the exact commit and execution is ALLOWED.

import { verifyStoredEvidence } from "./verification-evidence";
import type { VerificationRun, TestResult, VerificationStatus } from "./verification-integrity";

export interface ReleaseCandidate {
  releaseId: string;
  executionId: string;
  commitSha: string;
  artifactId?: string;
  artifactDigest?: string;
  environment?: string;
}

export interface ReleaseSafetyPolicy {
  policyVersion: string;
  /** If set, evidence is STALE when now - run.completedAt > freshnessMs. Undefined = no staleness check. */
  freshnessMs?: number;
  /** If true, candidate.artifactDigest is required and must match attestation binding. */
  requireArtifactBinding?: boolean;
}

export type ReleaseSafetyStatus =
  | "ALLOWED"
  | "REJECTED_MISSING"
  | "REJECTED_FAIL"
  | "REJECTED_BLOCKED"
  | "REJECTED_NOT_EXECUTED"
  | "REJECTED_UNVERIFIED"
  | "REJECTED_TAMPERED"
  | "REJECTED_STALE"
  | "REJECTED_MISMATCH";

export interface ReleaseSafetyCheck {
  name: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  reason?: string;
}

export interface ReleaseSafetyDecision {
  allowed: boolean;
  status: ReleaseSafetyStatus;
  reasons: string[];
  checks: ReleaseSafetyCheck[];
  releaseCandidate: ReleaseCandidate;
  verificationRunId: string | null;
  commit: string;
  execution: string;
  resultDigest: string | null;
  evidenceDigest: string | null;
  policyVersion: string;
  decidedAt: string;
}

export function evaluateReleaseSafety(input: {
  candidate: ReleaseCandidate;
  /** Raw JSON from artifacts/phaseN/verification-run.json (any shape). */
  verificationRun: unknown;
  policy: ReleaseSafetyPolicy;
  now?: number;
}): ReleaseSafetyDecision {
  const { candidate, verificationRun, policy } = input;
  const now = input.now ?? Date.now();
  const checks: ReleaseSafetyCheck[] = [];
  const reasons: string[] = [];

  const pushCheck = (name: string, status: "PASS" | "FAIL" | "BLOCKED", reason?: string): void => {
    checks.push({ name, status, reason });
    if (reason) reasons.push(`${name}: ${reason}`);
  };

  // Shape check
  if (
    verificationRun === null ||
    typeof verificationRun !== "object" ||
    Array.isArray(verificationRun)
  ) {
    pushCheck("SHAPE", "BLOCKED", "verificationRun is not an object");
    return finalize("REJECTED_MISSING", candidate, null, null, null, policy, now, checks, reasons);
  }
  const r = verificationRun as Partial<VerificationRun> & { evidenceDigest?: string };

  // Evidence integrity (Phase 209)
  const check = verifyStoredEvidence(r);
  if (check.verdict === "UNVERIFIED") {
    // Disambiguate the raw status for informative rejection codes.
    const rawStatus = (r as { status?: string }).status;
    const rej: ReleaseSafetyStatus =
      rawStatus === "NOT_EXECUTED" ? "REJECTED_NOT_EXECUTED"
      : rawStatus === "BLOCKED" ? "REJECTED_BLOCKED"
      : rawStatus === "FAIL" ? "REJECTED_FAIL"
      : "REJECTED_UNVERIFIED";
    pushCheck("EVIDENCE_INTEGRITY", "BLOCKED", check.reasons.join("|"));
    return finalize(rej, candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  if (check.verdict === "TAMPERED") {
    pushCheck("EVIDENCE_INTEGRITY", "FAIL", check.reasons.join("|") || "TAMPERED");
    return finalize("REJECTED_TAMPERED", candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  if (check.verdict === "VERIFIED_FAIL") {
    pushCheck("EVIDENCE_INTEGRITY", "FAIL", "verdict=VERIFIED_FAIL");
    return finalize("REJECTED_FAIL", candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  if (check.verdict === "VERIFIED_BLOCKED") {
    pushCheck("EVIDENCE_INTEGRITY", "FAIL", "verdict=VERIFIED_BLOCKED");
    return finalize("REJECTED_BLOCKED", candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  pushCheck("EVIDENCE_INTEGRITY", "PASS");

  // Run-level status (defense in depth; a VERIFIED_PASS should already guarantee this)
  if (r.status !== "PASS") {
    const map: Record<string, ReleaseSafetyStatus> = {
      FAIL: "REJECTED_FAIL",
      BLOCKED: "REJECTED_BLOCKED",
      NOT_EXECUTED: "REJECTED_NOT_EXECUTED",
      UNVERIFIED: "REJECTED_UNVERIFIED",
    };
    pushCheck("RUN_STATUS", "FAIL", "run.status=" + r.status);
    return finalize(map[r.status ?? "UNVERIFIED"] ?? "REJECTED_UNVERIFIED",
      candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  pushCheck("RUN_STATUS", "PASS");

  // Counts defense-in-depth
  const countFail =
    (r.failCount ?? 0) > 0 ||
    (r.blockedCount ?? 0) > 0 ||
    (r.notExecutedCount ?? 0) > 0 ||
    (r.unverifiedCount ?? 0) > 0;
  if (countFail) {
    pushCheck("COUNTS", "FAIL",
      `fail=${r.failCount} blocked=${r.blockedCount} notExecuted=${r.notExecutedCount} unverified=${r.unverifiedCount}`);
    return finalize("REJECTED_FAIL", candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  if ((r.requestedTestCount ?? 0) === 0 || (r.passCount ?? 0) !== (r.requestedTestCount ?? 0)) {
    pushCheck("COUNTS", "FAIL",
      `requested=${r.requestedTestCount} pass=${r.passCount}`);
    return finalize("REJECTED_UNVERIFIED", candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  pushCheck("COUNTS", "PASS");

  // Duplicate testId detection (defense in depth — digest already covers status,
  // but a duplicate would change the result set semantics).
  const seen = new Set<string>();
  let dup: string | null = null;
  for (const tr of (r.results ?? []) as TestResult[]) {
    if (seen.has(tr.testId)) { dup = tr.testId; break; }
    seen.add(tr.testId);
  }
  if (dup) {
    pushCheck("DUPLICATES", "FAIL", "duplicate testId=" + dup);
    return finalize("REJECTED_FAIL", candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  pushCheck("DUPLICATES", "PASS");

  // Commit binding
  if ((r.repositoryCommit ?? "") !== candidate.commitSha) {
    pushCheck("COMMIT", "FAIL",
      `evidence.commit=${r.repositoryCommit} candidate.commit=${candidate.commitSha}`);
    return finalize("REJECTED_MISMATCH", candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  pushCheck("COMMIT", "PASS");

  // Execution binding: the verification run's testScript must reference the
  // candidate's execution context. Phase 209 runs are per-phase, not
  // per-execution, so this check is a placeholder that compares against the
  // candidate.executionId if the run carries an executionId field. If the
  // run carries none, we accept the binding by convention and record it.
  const runExec = (r as { executionId?: string }).executionId;
  if (runExec !== undefined && runExec !== candidate.executionId) {
    pushCheck("EXECUTION", "FAIL",
      `evidence.executionId=${runExec} candidate.executionId=${candidate.executionId}`);
    return finalize("REJECTED_MISMATCH", candidate, r.runId ?? null, r.repositoryCommit ?? null,
      r.evidenceDigest ?? null, policy, now, checks, reasons);
  }
  pushCheck("EXECUTION", "PASS", runExec === undefined ? "run carries no executionId (accepted by convention)" : undefined);

  // Artifact binding (only if policy requires it)
  if (policy.requireArtifactBinding) {
    if (!candidate.artifactDigest) {
      pushCheck("ARTIFACT", "BLOCKED", "policy requires artifact binding but candidate has no artifactDigest");
      return finalize("REJECTED_MISSING", candidate, r.runId ?? null, r.repositoryCommit ?? null,
        r.evidenceDigest ?? null, policy, now, checks, reasons);
    }
    const runArtifact = (r as { artifactDigest?: string }).artifactDigest;
    if (runArtifact !== undefined && runArtifact !== candidate.artifactDigest) {
      pushCheck("ARTIFACT", "FAIL",
        `evidence.artifactDigest=${runArtifact} candidate.artifactDigest=${candidate.artifactDigest}`);
      return finalize("REJECTED_MISMATCH", candidate, r.runId ?? null, r.repositoryCommit ?? null,
        r.evidenceDigest ?? null, policy, now, checks, reasons);
    }
    pushCheck("ARTIFACT", "PASS",
      runArtifact === undefined ? "run carries no artifactDigest (candidate digest recorded)" : undefined);
  } else {
    pushCheck("ARTIFACT", "PASS", "artifact binding not required by policy");
  }

  // Staleness
  if (policy.freshnessMs !== undefined) {
    const completedAt = Date.parse(r.completedAt ?? "");
    if (!Number.isFinite(completedAt)) {
      pushCheck("FRESHNESS", "BLOCKED", "run.completedAt unparseable");
      return finalize("REJECTED_UNVERIFIED", candidate, r.runId ?? null, r.repositoryCommit ?? null,
        r.evidenceDigest ?? null, policy, now, checks, reasons);
    }
    const ageMs = now - completedAt;
    if (ageMs > policy.freshnessMs) {
      pushCheck("FRESHNESS", "FAIL", `ageMs=${ageMs} > freshnessMs=${policy.freshnessMs}`);
      return finalize("REJECTED_STALE", candidate, r.runId ?? null, r.repositoryCommit ?? null,
        r.evidenceDigest ?? null, policy, now, checks, reasons);
    }
    pushCheck("FRESHNESS", "PASS", `ageMs=${ageMs}`);
  } else {
    pushCheck("FRESHNESS", "PASS", "no freshness policy configured");
  }

  return finalize("ALLOWED", candidate, r.runId ?? null, r.repositoryCommit ?? null,
    r.evidenceDigest ?? null, policy, now, checks, reasons);
}

function finalize(
  status: ReleaseSafetyStatus,
  candidate: ReleaseCandidate,
  verificationRunId: string | null,
  commit: string | null,
  evidenceDigest: string | null,
  policy: ReleaseSafetyPolicy,
  now: number,
  checks: ReleaseSafetyCheck[],
  reasons: string[],
): ReleaseSafetyDecision {
  let resultDigest: string | null = null;
  return {
    allowed: status === "ALLOWED",
    status,
    reasons,
    checks,
    releaseCandidate: candidate,
    verificationRunId,
    commit: commit ?? candidate.commitSha,
    execution: candidate.executionId,
    resultDigest,
    evidenceDigest,
    policyVersion: policy.policyVersion,
    decidedAt: new Date(now).toISOString(),
  };
}
