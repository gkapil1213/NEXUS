// src/core/verification-integrity.ts
// Phase 209: pure verification-integrity helpers. No I/O, no persistence.
// Every consumer (CLI verifier, evidence generator, tamper checker) uses
// these so counts, digests and verdicts are computed identically.

import { createHash } from "node:crypto";

export type VerificationStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_EXECUTED" | "UNVERIFIED";

export interface TestResult {
  testId: string;
  name: string;
  status: VerificationStatus;
  note: string;
}

export interface VerificationRun {
  runId: string;
  phase: number;
  suite: string;
  startedAt: string;
  completedAt: string;
  status: VerificationStatus;
  requestedTestCount: number;
  executedTestCount: number;
  passCount: number;
  failCount: number;
  blockedCount: number;
  notExecutedCount: number;
  unverifiedCount: number;
  exitCode: number;
  repositoryCommit: string;
  repositoryBranch: string;
  testScript: string;
  results: TestResult[];
  resultDigest: string;
}

export interface Manifest {
  phase: number;
  suite: string;
  testScript: string;
  requiredTestIds: string[];
}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return "null";
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic digest of a result set. Order-independent. The human-readable
 * `note` is intentionally excluded so prose variations (e.g. "fenced=15" vs
 * "fenced=16" because of concurrent database activity) do not change the digest.
 * Only (testId, status) participate.
 */
export function digestResults(results: TestResult[]): string {
  const projection = results
    .map((r) => ({ testId: r.testId, status: r.status }))
    .sort((a, b) => a.testId.localeCompare(b.testId));
  return sha256(canonicalize(projection));
}

export function parseTestOutput(stdout: string): TestResult[] {
  const results: TestResult[] = [];
  const re = /^\[(PASS|FAIL|BLK |N\/E )\]\s+(\S+)\s+(.+?)\s+--\s+(.*)$/;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const [, mark, testId, name, note] = m;
    const status: VerificationStatus =
      mark === "PASS" ? "PASS" :
      mark === "FAIL" ? "FAIL" :
      mark === "BLK " ? "BLOCKED" :
      "NOT_EXECUTED";
    results.push({ testId, name, status, note });
  }
  return results;
}

export interface VerdictInput {
  results: TestResult[];
  manifest: Manifest;
  exitCode: number;
  repositoryCommit: string;
  repositoryBranch: string;
  startedAt: string;
  completedAt: string;
  runId: string;
}

export interface VerdictOutcome {
  verdict: VerificationStatus;
  reasons: string[];
  run: VerificationRun;
}

export function computeVerdict(input: VerdictInput): VerdictOutcome {
  const reasons: string[] = [];
  const found = new Map<string, TestResult>();
  for (const r of input.results) {
    if (found.has(r.testId)) reasons.push("DUPLICATE_RESULT:" + r.testId);
    found.set(r.testId, r);
  }

  const requiredSet = new Set(input.manifest.requiredTestIds);
  const missing: string[] = [];
  for (const id of input.manifest.requiredTestIds) if (!found.has(id)) missing.push(id);
  const unexpected: string[] = [];
  for (const id of found.keys()) if (!requiredSet.has(id)) unexpected.push(id);

  let passCount = 0, failCount = 0, blockedCount = 0, notExecutedCount = 0, unverifiedCount = 0;
  for (const id of input.manifest.requiredTestIds) {
    const r = found.get(id);
    if (!r) { notExecutedCount++; continue; }
    switch (r.status) {
      case "PASS": passCount++; break;
      case "FAIL": failCount++; break;
      case "BLOCKED": blockedCount++; break;
      case "NOT_EXECUTED": notExecutedCount++; break;
      case "UNVERIFIED": unverifiedCount++; break;
    }
  }

  if (input.exitCode !== 0) reasons.push("NONZERO_EXIT:" + input.exitCode);
  if (missing.length > 0) reasons.push("MISSING_REQUIRED:" + missing.join(","));
  if (unexpected.length > 0) reasons.push("UNEXPECTED_TEST:" + unexpected.join(","));
  if (failCount > 0) reasons.push("FAIL:" + failCount);
  if (blockedCount > 0) reasons.push("BLOCKED:" + blockedCount);
  if (notExecutedCount > 0) reasons.push("NOT_EXECUTED:" + notExecutedCount);
  if (unverifiedCount > 0) reasons.push("UNVERIFIED:" + unverifiedCount);

  let verdict: VerificationStatus;
  if (reasons.length === 0) verdict = "PASS";
  else if (failCount > 0) verdict = "FAIL";
  else if (blockedCount > 0 && notExecutedCount === 0) verdict = "BLOCKED";
  else if (unverifiedCount > 0 && failCount === 0 && blockedCount === 0) verdict = "UNVERIFIED";
  else if (notExecutedCount > 0 && failCount === 0 && blockedCount === 0 && unverifiedCount === 0) verdict = "UNVERIFIED";
  else verdict = "FAIL";

  const executedTestCount = passCount + failCount + blockedCount;

  const run: VerificationRun = {
    runId: input.runId,
    phase: input.manifest.phase,
    suite: input.manifest.suite,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: verdict,
    requestedTestCount: input.manifest.requiredTestIds.length,
    executedTestCount,
    passCount,
    failCount,
    blockedCount,
    notExecutedCount,
    unverifiedCount,
    exitCode: input.exitCode,
    repositoryCommit: input.repositoryCommit,
    repositoryBranch: input.repositoryBranch,
    testScript: input.manifest.testScript,
    results: [...found.values()].sort((a, b) => a.testId.localeCompare(b.testId)),
    resultDigest: digestResults([...found.values()]),
  };
  return { verdict, reasons, run };
}

/**
 * Digest over the evidence-worthy projection of a VerificationRun. Excludes
 * timestamps, so two runs producing identical results at different times
 * produce the same digest. Any change to a test result changes the digest.
 */
export function evidenceDigest(run: VerificationRun): string {
  return sha256(canonicalize({
    runId: run.runId,
    phase: run.phase,
    suite: run.suite,
    repositoryCommit: run.repositoryCommit,
    repositoryBranch: run.repositoryBranch,
    testScript: run.testScript,
    requestedTestCount: run.requestedTestCount,
    executedTestCount: run.executedTestCount,
    passCount: run.passCount,
    failCount: run.failCount,
    blockedCount: run.blockedCount,
    notExecutedCount: run.notExecutedCount,
    unverifiedCount: run.unverifiedCount,
    resultDigest: run.resultDigest,
    results: run.results.map((r) => ({ testId: r.testId, status: r.status })),
  }));
}

export function exitCodeForVerdict(v: VerificationStatus): number {
  return v === "PASS" ? 0 : v === "FAIL" ? 1 : v === "BLOCKED" ? 2 : 3;
}
