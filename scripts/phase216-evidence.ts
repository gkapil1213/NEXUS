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
  const runPath = resolve("artifacts/phase216/verification-run.json");
  if (!existsSync(runPath)) {
    console.error("verification-run.json not found; run: npx tsx scripts/verify-phase.ts 216 first");
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(runPath, "utf8"));
  const check = verifyStoredEvidence(raw);
  // Phase 216 explicitly allows VERIFIED_BLOCKED for real-provider tests that
  // cannot run in an environment with no live AI provider configured. Only
  // VERIFIED_FAIL and TAMPERED are rejected outright.
  if (check.verdict === "VERIFIED_FAIL" || check.verdict === "TAMPERED") {
    console.error("verification run failed integrity check:", check.verdict, check.reasons.join("|"));
    process.exit(1);
  }
  if (check.verdict === "UNVERIFIED") {
    console.error("verification run cannot be verified:", check.verdict, check.reasons.join("|"));
    process.exit(3);
  }
  const run = raw as VerificationRun & { evidenceDigest: string };
  const commit = sh("git rev-parse HEAD");
  const branch = sh("git rev-parse --abbrev-ref HEAD");
  const generatedAt = new Date().toISOString();
  const evidence = {
    phase: 216,
    generatedAt, repositoryCommit: commit, repositoryBranch: branch,
    verificationRunId: run.runId, verificationRunCommit: run.repositoryCommit,
    testScript: run.testScript,
    requestedTestCount: run.requestedTestCount, executedTestCount: run.executedTestCount,
    passCount: run.passCount, failCount: run.failCount,
    blockedCount: run.blockedCount, notExecutedCount: run.notExecutedCount,
    unverifiedCount: run.unverifiedCount, exitCode: run.exitCode, status: run.status,
    resultDigest: run.resultDigest, evidenceDigest: run.evidenceDigest,
    integrity: {
      verdict: check.verdict,
      resultDigestMatches: check.providedResultDigest === check.recomputedResultDigest,
      evidenceDigestMatches: check.providedEvidenceDigest === check.recomputedEvidenceDigest,
    },
    realProviderVerification: {
      status: run.blockedCount > 0 ? "BLOCKED" : "PASS",
      blockedTests: run.results.filter((r) => r.status === "BLOCKED").map((r) => r.testId),
      reason: run.blockedCount > 0
        ? "no real AI provider configured in the verification environment"
        : "real provider configured and executed",
    },
    results: run.results,
  };
  mkdirSync(resolve("artifacts/phase216"), { recursive: true });
  writeFileSync(resolve("artifacts/phase216/phase216-evidence.json"), JSON.stringify(evidence, null, 2));
  writeFileSync(resolve("artifacts/phase216/phase216-summary.json"), JSON.stringify({
    phase: 216, generatedAt, repositoryCommit: commit, verificationRunId: run.runId,
    status: run.status, PASS: run.passCount, FAIL: run.failCount,
    BLOCKED: run.blockedCount, "NOT EXECUTED": run.notExecutedCount,
    UNVERIFIED: run.unverifiedCount,
    resultDigest: run.resultDigest, evidenceDigest: run.evidenceDigest,
    realProviderVerification: evidence.realProviderVerification,
  }, null, 2));
  console.log("phase216 evidence written");
  console.log(`status=${run.status} PASS=${run.passCount} FAIL=${run.failCount} BLOCKED=${run.blockedCount} NOT_EXECUTED=${run.notExecutedCount} UNVERIFIED=${run.unverifiedCount}`);
  console.log(`realProviderVerification=${evidence.realProviderVerification.status} blockedTests=${evidence.realProviderVerification.blockedTests.join(",")}`);
  console.log(`resultDigest=${run.resultDigest}`);
  console.log(`evidenceDigest=${run.evidenceDigest}`);
}
main();
