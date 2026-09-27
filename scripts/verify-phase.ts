// scripts/verify-phase.ts
// Phase 209: production CLI verifier. Executes the phase's real test script,
// captures its actual exit code and stdout, parses per-test results, and
// computes a fail-closed verdict. Persists the durable verification run.
//
// Usage:  npx tsx scripts/verify-phase.ts <phase>
// Exit:   0=PASS  1=FAIL  2=BLOCKED  3=UNVERIFIED  4=MANIFEST_ERROR
//
// The verdict is derived only from (a) the test process exit code, (b) the
// parsed per-test lines, and (c) the manifest of required test IDs. No
// hard-coded counts. No user-supplied PASS.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseTestOutput,
  computeVerdict,
  evidenceDigest,
  exitCodeForVerdict,
  type VerificationRun,
} from "../src/core/verification-integrity";
import { getManifest } from "../src/core/verification-manifest";

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function main(): void {
  const phaseArg = process.argv[2];
  if (!phaseArg || !/^\d+$/.test(phaseArg)) {
    console.error("usage: verify-phase.ts <phase>");
    process.exit(4);
  }
  const phase = Number(phaseArg);

  let manifest;
  try {
    manifest = getManifest(phase);
  } catch (e) {
    console.error("manifest error:", e instanceof Error ? e.message : String(e));
    process.exit(4);
  }

  const repositoryCommit = sh("git rev-parse HEAD");
  const repositoryBranch = sh("git rev-parse --abbrev-ref HEAD");
  const runId = `verify-${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const startedAt = new Date().toISOString();
  console.log(`[verify-phase] phase=${phase} suite=${manifest.suite}`);
  console.log(`[verify-phase] commit=${repositoryCommit} branch=${repositoryBranch}`);
  console.log(`[verify-phase] script=${manifest.testScript}`);
  console.log(`[verify-phase] required test count=${manifest.requiredTestIds.length}`);

  const t0 = Date.now();
  // execSync is the proven path on Windows here. spawnSync with npx.cmd
  // returned status=null (spawn failure) even though npx is on PATH.
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execSync(
      "npx tsx " + manifest.testScript,
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    exitCode = 0;
  } catch (e: any) {
    exitCode = typeof e.status === "number" ? e.status : -1;
    if (e.stdout) stdout = String(e.stdout);
    if (e.stderr) stderr = String(e.stderr);
  }
  const durationMs = Date.now() - t0;
  const completedAt = new Date().toISOString();

  // Echo the raw test output so the caller sees real evidence in real time.
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const results = parseTestOutput(stdout);
  console.log(`[verify-phase] parsed ${results.length} result lines in ${durationMs}ms`);

  const outcome = computeVerdict({
    results,
    manifest,
    exitCode,
    repositoryCommit,
    repositoryBranch,
    startedAt,
    completedAt,
    runId,
  });

  const artifactDir = resolve(`artifacts/phase${phase}`);
  mkdirSync(artifactDir, { recursive: true });

  const run: VerificationRun = outcome.run;
  const digest = evidenceDigest(run);

  writeFileSync(
    resolve(artifactDir, "verification-run.json"),
    JSON.stringify({ ...run, evidenceDigest: digest }, null, 2),
  );
  writeFileSync(
    resolve(artifactDir, "verification-results.json"),
    JSON.stringify(run.results, null, 2),
  );
  writeFileSync(
    resolve(artifactDir, "verification-summary.json"),
    JSON.stringify(
      {
        phase: run.phase,
        suite: run.suite,
        runId: run.runId,
        status: run.status,
        requestedTestCount: run.requestedTestCount,
        executedTestCount: run.executedTestCount,
        passCount: run.passCount,
        failCount: run.failCount,
        blockedCount: run.blockedCount,
        notExecutedCount: run.notExecutedCount,
        unverifiedCount: run.unverifiedCount,
        exitCode: run.exitCode,
        repositoryCommit: run.repositoryCommit,
        repositoryBranch: run.repositoryBranch,
        resultDigest: run.resultDigest,
        evidenceDigest: digest,
        reasons: outcome.reasons,
        generatedAt: completedAt,
      },
      null,
      2,
    ),
  );

  console.log(`\n===== Phase ${phase} verification verdict =====`);
  console.log(`VERDICT: ${outcome.verdict}`);
  console.log(`PASS: ${run.passCount}`);
  console.log(`FAIL: ${run.failCount}`);
  console.log(`BLOCKED: ${run.blockedCount}`);
  console.log(`NOT EXECUTED: ${run.notExecutedCount}`);
  console.log(`UNVERIFIED: ${run.unverifiedCount}`);
  console.log(`requested=${run.requestedTestCount} executed=${run.executedTestCount}`);
  console.log(`resultDigest: ${run.resultDigest}`);
  console.log(`evidenceDigest: ${digest}`);
  if (outcome.reasons.length > 0) {
    console.log(`reasons: ${outcome.reasons.join(" | ")}`);
  }

  process.exit(exitCodeForVerdict(outcome.verdict));
}

main();
