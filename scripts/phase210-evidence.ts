// scripts/phase210-evidence.ts
// Phase 210: evidence generator. Derives from artifacts/phase210/verification-run.json.
// No hardcoded counts. Fails if digests do not match.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { verifyStoredEvidence } from "../src/core/verification-evidence";
import type { VerificationRun } from "../src/core/verification-integrity";

function sh(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore","pipe","pipe"] }).trim(); }
  catch { return ""; }
}

function main(): void {
  const runPath = resolve("artifacts/phase210/verification-run.json");
  if (!existsSync(runPath)) {
    console.error("verification-run.json not found; run: npx tsx scripts/verify-phase.ts 210 first");
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(runPath, "utf8"));
  const check = verifyStoredEvidence(raw);
  if (check.verdict !== "VERIFIED_PASS") {
    console.error("verification run failed integrity check:", check.verdict, check.reasons.join("|"));
    process.exit(1);
  }
  const run = raw as VerificationRun & { evidenceDigest: string };

  const commit = sh("git rev-parse HEAD");
  const branch = sh("git rev-parse --abbrev-ref HEAD");
  const generatedAt = new Date().toISOString();

  const evidence = {
    phase: 210,
    generatedAt,
    repositoryCommit: commit,
    repositoryBranch: branch,
    verificationRunId: run.runId,
    verificationRunCommit: run.repositoryCommit,
    testScript: run.testScript,
    requestedTestCount: run.requestedTestCount,
    executedTestCount: run.executedTestCount,
    passCount: run.passCount,
    failCount: run.failCount,
    blockedCount: run.blockedCount,
    notExecutedCount: run.notExecutedCount,
    unverifiedCount: run.unverifiedCount,
    exitCode: run.exitCode,
    status: run.status,
    resultDigest: run.resultDigest,
    evidenceDigest: run.evidenceDigest,
    integrity: {
      verdict: check.verdict,
      resultDigestMatches: check.providedResultDigest === check.recomputedResultDigest,
      evidenceDigestMatches: check.providedEvidenceDigest === check.recomputedEvidenceDigest,
    },
    results: run.results,
  };

  mkdirSync(resolve("artifacts/phase210"), { recursive: true });
  writeFileSync(resolve("artifacts/phase210/phase210-evidence.json"), JSON.stringify(evidence, null, 2));
  writeFileSync(resolve("artifacts/phase210/phase210-summary.json"), JSON.stringify({
    phase: 210,
    generatedAt,
    repositoryCommit: commit,
    verificationRunId: run.runId,
    status: run.status,
    PASS: run.passCount,
    FAIL: run.failCount,
    BLOCKED: run.blockedCount,
    "NOT EXECUTED": run.notExecutedCount,
    UNVERIFIED: run.unverifiedCount,
    resultDigest: run.resultDigest,
    evidenceDigest: run.evidenceDigest,
  }, null, 2));

  console.log("phase210 evidence written");
  console.log(`status=${run.status} PASS=${run.passCount} FAIL=${run.failCount} BLOCKED=${run.blockedCount} NOT_EXECUTED=${run.notExecutedCount} UNVERIFIED=${run.unverifiedCount}`);
  console.log(`resultDigest=${run.resultDigest}`);
  console.log(`evidenceDigest=${run.evidenceDigest}`);
}

main();
