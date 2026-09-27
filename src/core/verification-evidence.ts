// src/core/verification-evidence.ts
// Phase 209: evidence integrity verifier. Reads a persisted VerificationRun,
// recomputes both digests, and fails closed on any mismatch.
//
// A run without an `evidenceDigest` (e.g. the legacy hand-authored Phase 208
// artifact) is returned as UNVERIFIED — it is not assumed PASS merely because
// its JSON says PASS.

import { createHash } from "node:crypto";
import {
  canonicalize,
  sha256,
  digestResults,
  evidenceDigest as computeEvidenceDigest,
  type VerificationRun,
} from "./verification-integrity";

export type EvidenceVerdict =
  | "VERIFIED_PASS"
  | "VERIFIED_FAIL"
  | "VERIFIED_BLOCKED"
  | "TAMPERED"
  | "UNVERIFIED";

export interface EvidenceCheck {
  verdict: EvidenceVerdict;
  reasons: string[];
  recomputedResultDigest: string | null;
  recomputedEvidenceDigest: string | null;
  providedResultDigest: string | null;
  providedEvidenceDigest: string | null;
}

interface StoredEvidence extends VerificationRun {
  evidenceDigest?: string;
}

export function verifyStoredEvidence(raw: unknown): EvidenceCheck {
  const reasons: string[] = [];
  const empty: EvidenceCheck = {
    verdict: "UNVERIFIED",
    reasons: ["NOT_A_RUN_OBJECT"],
    recomputedResultDigest: null,
    recomputedEvidenceDigest: null,
    providedResultDigest: null,
    providedEvidenceDigest: null,
  };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const r = raw as Partial<StoredEvidence>;

  const hasShape =
    typeof r.phase === "number" &&
    typeof r.suite === "string" &&
    Array.isArray(r.results) &&
    typeof r.resultDigest === "string" &&
    typeof r.status === "string";

  if (!hasShape) {
    return { ...empty, reasons: ["MISSING_REQUIRED_FIELDS"] };
  }

  const providedResultDigest = r.resultDigest ?? null;
  const recomputedResultDigest = digestResults(r.results!);

  let verdict: EvidenceVerdict;
  let recomputedEvidenceDigest: string | null = null;
  const providedEvidenceDigest = typeof r.evidenceDigest === "string" ? r.evidenceDigest : null;

  if (providedResultDigest !== recomputedResultDigest) {
    reasons.push("RESULT_DIGEST_MISMATCH");
  }

  if (!providedEvidenceDigest) {
    reasons.push("MISSING_EVIDENCE_DIGEST");
    // No evidence digest to compare, so we cannot assert tamper or pass.
    return {
      verdict: "UNVERIFIED",
      reasons,
      recomputedResultDigest,
      recomputedEvidenceDigest: null,
      providedResultDigest,
      providedEvidenceDigest: null,
    };
  }

  // Reconstruct the run object using its declared fields and compute the
  // canonical evidence digest. The digest is order-independent over test IDs
  // and excludes notes and timestamps by construction.
  const run: VerificationRun = {
    runId: r.runId ?? "",
    phase: r.phase!,
    suite: r.suite!,
    startedAt: r.startedAt ?? "",
    completedAt: r.completedAt ?? "",
    status: r.status as VerificationRun["status"],
    requestedTestCount: r.requestedTestCount ?? 0,
    executedTestCount: r.executedTestCount ?? 0,
    passCount: r.passCount ?? 0,
    failCount: r.failCount ?? 0,
    blockedCount: r.blockedCount ?? 0,
    notExecutedCount: r.notExecutedCount ?? 0,
    unverifiedCount: r.unverifiedCount ?? 0,
    exitCode: r.exitCode ?? 0,
    repositoryCommit: r.repositoryCommit ?? "",
    repositoryBranch: r.repositoryBranch ?? "",
    testScript: r.testScript ?? "",
    results: r.results!,
    resultDigest: providedResultDigest!,
  };
  recomputedEvidenceDigest = computeEvidenceDigest(run);

  if (recomputedEvidenceDigest !== providedEvidenceDigest) {
    reasons.push("EVIDENCE_DIGEST_MISMATCH");
    verdict = "TAMPERED";
  } else if (reasons.length === 0) {
    verdict = r.status === "PASS" ? "VERIFIED_PASS"
      : r.status === "FAIL" ? "VERIFIED_FAIL"
      : r.status === "BLOCKED" ? "VERIFIED_BLOCKED"
      : "UNVERIFIED";
  } else {
    verdict = "TAMPERED";
  }

  return {
    verdict,
    reasons,
    recomputedResultDigest,
    recomputedEvidenceDigest,
    providedResultDigest,
    providedEvidenceDigest,
  };
}

export function digestFileBytes(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export { canonicalize, sha256 };
