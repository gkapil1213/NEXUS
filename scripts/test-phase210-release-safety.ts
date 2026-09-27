// scripts/test-phase210-release-safety.ts
// Phase 210 — Evidence-Backed Release Safety Gate.
// Drives the real ReleaseSafetyGate against real Phase 209 verification-run
// objects. Every scenario builds a genuine VerificationRun, computes real
// digests via the Phase 209 primitives, then exercises the gate and asserts
// the fail-closed invariant. No mocked gate. No hardcoded verdicts.

import {
  digestResults, evidenceDigest,
  type VerificationRun, type TestResult,
} from "../src/core/verification-integrity";
import {
  evaluateReleaseSafety, type ReleaseCandidate, type ReleaseSafetyPolicy,
} from "../src/core/release-safety-gate";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

const TEST_IDS = ["208A","208B","208C","208D","208E","208F","208G","208H","208I","208J",
  "208K","208L","208M","208N","208O","208P","208Q","208R","208S","208T"];

const FIXED_COMMIT = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const FIXED_EXEC = "phase210-synthetic-exec";
const FIXED_RUN_ID = "synthetic-210-run";

function baseResults(status: "PASS" | "FAIL" = "PASS"): TestResult[] {
  return TEST_IDS.map((id) => ({ testId: id, name: id, status, note: "synthetic" }));
}

function buildRun(overrides: Partial<VerificationRun> & { evidenceDigest?: string } = {}): VerificationRun & { evidenceDigest: string } {
  const results = overrides.results ?? baseResults();
  const passCount = results.filter((r) => r.status === "PASS").length;
  const failCount = results.filter((r) => r.status === "FAIL").length;
  const blockedCount = results.filter((r) => r.status === "BLOCKED").length;
  const notExecutedCount = results.filter((r) => r.status === "NOT_EXECUTED").length;
  const unverifiedCount = results.filter((r) => r.status === "UNVERIFIED").length;
  const run: VerificationRun = {
    runId: FIXED_RUN_ID,
    phase: 208,
    suite: "synthetic",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    status: "PASS",
    requestedTestCount: TEST_IDS.length,
    executedTestCount: passCount + failCount + blockedCount,
    passCount,
    failCount,
    blockedCount,
    notExecutedCount,
    unverifiedCount,
    exitCode: 0,
    repositoryCommit: FIXED_COMMIT,
    repositoryBranch: "master",
    testScript: "scripts/test-phase208-worker-execution-runtime.ts",
    results,
    resultDigest: digestResults(results),
    ...overrides,
  };
  const digest = overrides.evidenceDigest ?? evidenceDigest(run);
  return { ...run, evidenceDigest: digest };
}

const CANDIDATE: ReleaseCandidate = {
  releaseId: "rel-210-001",
  executionId: FIXED_EXEC,
  commitSha: FIXED_COMMIT,
  artifactId: "art-210-001",
  artifactDigest: "sha256:" + "a".repeat(64),
  environment: "production",
};

const POLICY: ReleaseSafetyPolicy = { policyVersion: "release-safety-v1" };

async function main(): Promise<void> {
  // 210A valid complete chain
  try {
    const run = buildRun();
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    ok(d.allowed === true, `not allowed: ${d.status} reasons=${d.reasons.join("|")}`);
    ok(d.status === "ALLOWED", `status=${d.status}`);
    ok(d.verificationRunId === FIXED_RUN_ID, `runId=${d.verificationRunId}`);
    ok(d.commit === FIXED_COMMIT, `commit=${d.commit}`);
    record("210A", "valid release candidate", "PASS", `status=${d.status}`);
  } catch (e) { record("210A", "valid release candidate", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210B commit mismatch
  try {
    const run = buildRun();
    const c: ReleaseCandidate = { ...CANDIDATE, commitSha: "1111111111111111111111111111111111111111" };
    const d = evaluateReleaseSafety({ candidate: c, verificationRun: run, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_MISMATCH", `status=${d.status}`);
    ok(d.reasons.some((r) => r.includes("COMMIT")), `missing COMMIT reason`);
    record("210B", "commit mismatch", "PASS", `status=${d.status}`);
  } catch (e) { record("210B", "commit mismatch", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210C evidence digest tamper
  try {
    const run = buildRun();
    const tampered = { ...run, evidenceDigest: "0".repeat(64) };
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: tampered, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_TAMPERED", `status=${d.status}`);
    record("210C", "evidence digest mismatch", "PASS", `status=${d.status}`);
  } catch (e) { record("210C", "evidence digest mismatch", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210D result digest tamper
  try {
    const run = buildRun();
    const tampered = { ...run, resultDigest: "0".repeat(64) };
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: tampered, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_TAMPERED", `status=${d.status}`);
    record("210D", "result digest mismatch", "PASS", `status=${d.status}`);
  } catch (e) { record("210D", "result digest mismatch", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210E missing required test
  try {
    const results = baseResults().filter((r) => r.testId !== "208S");
    const run = buildRun({ results, status: "UNVERIFIED", notExecutedCount: 1, requestedTestCount: 20, passCount: 19 });
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status.startsWith("REJECTED_"), `status=${d.status}`);
    record("210E", "missing required test", "PASS", `status=${d.status}`);
  } catch (e) { record("210E", "missing required test", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210F BLOCKED verification
  try {
    const results = baseResults("PASS").map((r) => r.testId === "208D" ? { ...r, status: "BLOCKED" as const } : r);
    const run = buildRun({ results, status: "BLOCKED", blockedCount: 1 });
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_BLOCKED", `status=${d.status}`);
    record("210F", "BLOCKED verification", "PASS", `status=${d.status}`);
  } catch (e) { record("210F", "BLOCKED verification", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210G NOT_EXECUTED verification
  try {
    const results = baseResults("PASS").map((r) => r.testId === "208T" ? { ...r, status: "NOT_EXECUTED" as const } : r);
    const run = buildRun({ results, status: "NOT_EXECUTED", notExecutedCount: 1 });
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_NOT_EXECUTED" || d.status.startsWith("REJECTED_"), `status=${d.status}`);
    record("210G", "NOT_EXECUTED verification", "PASS", `status=${d.status}`);
  } catch (e) { record("210G", "NOT_EXECUTED verification", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210H verification FAIL
  try {
    const results = baseResults("PASS").map((r) => r.testId === "208K" ? { ...r, status: "FAIL" as const } : r);
    const run = buildRun({ results, status: "FAIL", failCount: 1, passCount: 19, exitCode: 1 });
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_FAIL", `status=${d.status}`);
    record("210H", "verification FAIL", "PASS", `status=${d.status}`);
  } catch (e) { record("210H", "verification FAIL", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210I stale evidence
  try {
    const run = buildRun({ completedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() });
    const policy: ReleaseSafetyPolicy = { policyVersion: "release-safety-v1", freshnessMs: 3600 * 1000 };
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_STALE", `status=${d.status}`);
    record("210I", "stale evidence", "PASS", `status=${d.status}`);
  } catch (e) { record("210I", "stale evidence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210J artifact mismatch — run records a different artifact digest than
  // the candidate claims, and policy requires binding.
  try {
    const runWithArtifact: any = { ...buildRun(), artifactDigest: "sha256:" + "x".repeat(64) };
    const c: ReleaseCandidate = { ...CANDIDATE, artifactDigest: "sha256:" + "b".repeat(64) };
    const policy: ReleaseSafetyPolicy = { policyVersion: "release-safety-v1", requireArtifactBinding: true };
    const d = evaluateReleaseSafety({ candidate: c, verificationRun: runWithArtifact, policy });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_MISMATCH", `status=${d.status}`);
    ok(d.reasons.some((r) => r.includes("ARTIFACT")), `missing ARTIFACT reason: ${d.reasons.join("|")}`);
    record("210J", "artifact mismatch", "PASS", `status=${d.status}`);
  } catch (e) { record("210J", "artifact mismatch", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210K duplicate verification results
  try {
    const base = baseResults();
    const withDup: TestResult[] = [...base, { testId: "208A", name: "dupe", status: "FAIL", note: "" }];
    // Bypass buildRun — we need to inject a run whose results contain a duplicate.
    // construct manually so digestResults still computes over the duplicated set.
    const run: any = {
      runId: FIXED_RUN_ID, phase: 208, suite: "synthetic",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z",
      status: "PASS", requestedTestCount: 20, executedTestCount: 21,
      passCount: 20, failCount: 1, blockedCount: 0, notExecutedCount: 0, unverifiedCount: 0,
      exitCode: 0, repositoryCommit: FIXED_COMMIT, repositoryBranch: "master",
      testScript: "scripts/test-phase208-worker-execution-runtime.ts",
      results: withDup, resultDigest: digestResults(withDup),
    };
    run.evidenceDigest = evidenceDigest(run);
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.reasons.some((r) => r.includes("DUPLICATES") || r.includes("COUNTS") || r.includes("RUN_STATUS")),
       `expected duplicate/count reason, got ${d.reasons.join("|")}`);
    record("210K", "duplicate verification results", "PASS", `status=${d.status}`);
  } catch (e) { record("210K", "duplicate verification results", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210L process restart durability — pure function, so determinism across
  // a fresh computeVerdict call is the equivalent test.
  try {
    const run = buildRun();
    const d1 = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    // Simulate restart by re-parsing JSON round-trip of the run.
    const roundTripped = JSON.parse(JSON.stringify(run));
    const d2 = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: roundTripped, policy: POLICY });
    ok(d1.status === d2.status, `status differs across restart: ${d1.status} vs ${d2.status}`);
    ok(d1.allowed === d2.allowed, `allowed differs across restart`);
    record("210L", "process restart durability", "PASS", `status=${d1.status}`);
  } catch (e) { record("210L", "process restart durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210M repeated evaluation
  try {
    const run = buildRun();
    const a = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    const b = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    const c = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    ok(a.status === b.status && b.status === c.status, `status differs`);
    ok(a.allowed === b.allowed && b.allowed === c.allowed, `allowed differs`);
    // Compare reasons arrays for equality across the three evaluations.
    const reasonsEqual =
      JSON.stringify(a.reasons) === JSON.stringify(b.reasons) &&
      JSON.stringify(b.reasons) === JSON.stringify(c.reasons);
    ok(reasonsEqual, `reasons differ across runs: ${JSON.stringify([a.reasons, b.reasons, c.reasons])}`);
    record("210M", "repeated evaluation", "PASS", `status=${a.status} x3, reasons identical`);
  } catch (e) { record("210M", "repeated evaluation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210N concurrent evaluation
  try {
    const run = buildRun();
    // Concurrent evaluation: since evaluateReleaseSafety is synchronous and
    // pure, launching multiple Promise.resolve().then calls executes them in
    // the same microtask queue with no shared mutable state — the equivalent
    // of concurrent independent invocations.
    const results = await Promise.all([
      Promise.resolve().then(() => evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY })),
      Promise.resolve().then(() => evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY })),
      Promise.resolve().then(() => evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY })),
      Promise.resolve().then(() => evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY })),
    ]);
    const statuses = new Set(results.map((d) => d.status));
    ok(statuses.size === 1, `statuses diverged: ${[...statuses].join(",")}`);
    ok(results.every((d) => d.allowed === results[0].allowed), `allowed diverged`);
    record("210N", "concurrent evaluation", "PASS", `4 concurrent, single status=${results[0].status}`);
  } catch (e) { record("210N", "concurrent evaluation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210O modified repository after verification
  try {
    const run = buildRun();
    // Candidate claims a different commit than the verified one — equivalent
    // to "repo moved forward after verification".
    const c: ReleaseCandidate = { ...CANDIDATE, commitSha: "cafebabecafebabecafebabecafebabecafebabe" };
    const d = evaluateReleaseSafety({ candidate: c, verificationRun: run, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_MISMATCH", `status=${d.status}`);
    record("210O", "modified repository after verification", "PASS", `status=${d.status}`);
  } catch (e) { record("210O", "modified repository after verification", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210P evidence replay against another candidate
  try {
    const run = buildRun();
    // Same evidence, different candidate release — commit differs.
    const other: ReleaseCandidate = { ...CANDIDATE, releaseId: "rel-210-other", commitSha: "2222222222222222222222222222222222222222" };
    const d = evaluateReleaseSafety({ candidate: other, verificationRun: run, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_MISMATCH", `status=${d.status}`);
    record("210P", "evidence replay against another candidate", "PASS", `status=${d.status}`);
  } catch (e) { record("210P", "evidence replay against another candidate", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210Q malformed evidence
  try {
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: "not-an-object", policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_MISSING", `status=${d.status}`);
    // Also test: run missing required fields
    const d2 = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: { foo: "bar" }, policy: POLICY });
    ok(!d2.allowed, `should reject malformed`);
    record("210Q", "malformed evidence", "PASS", `status=${d.status}`);
  } catch (e) { record("210Q", "malformed evidence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210R missing evidence
  try {
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: null, policy: POLICY });
    ok(!d.allowed, `should reject`);
    ok(d.status === "REJECTED_MISSING", `status=${d.status}`);
    record("210R", "missing evidence", "PASS", `status=${d.status}`);
  } catch (e) { record("210R", "missing evidence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210S valid complete chain — commit → execution → verification → digests → artifact → candidate → gate
  try {
    // Full chain: commit → execution → verification → digests → artifact → candidate → gate.
    // The fixture run carries the same artifactDigest as the candidate so the
    // artifact binding check passes; freshness is evaluated against the
    // fixture completedAt (not wall-clock now) to keep the test deterministic.
    const runWithArtifact: any = { ...buildRun(), artifactDigest: CANDIDATE.artifactDigest };
    ok(runWithArtifact.repositoryCommit === CANDIDATE.commitSha, "chain: commit");
    ok(runWithArtifact.status === "PASS", "chain: run status");
    ok(runWithArtifact.resultDigest === digestResults(runWithArtifact.results), "chain: result digest");
    ok(runWithArtifact.evidenceDigest === evidenceDigest(runWithArtifact as unknown as VerificationRun), "chain: evidence digest");
    ok(!!CANDIDATE.artifactDigest, "chain: artifact digest present");
    const policy: ReleaseSafetyPolicy = { policyVersion: "release-safety-v1", requireArtifactBinding: true, freshnessMs: 3600 * 1000 };
    // Pass `now` aligned to the fixture's completedAt so the freshness check
    // is deterministic and not dependent on wall-clock time.
    const fixtureNow = Date.parse(runWithArtifact.completedAt) + 1000;
    const d = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: runWithArtifact, policy, now: fixtureNow });
    ok(d.allowed, `chain gate blocked: ${d.status} ${d.reasons.join("|")}`);
    record("210S", "valid complete chain", "PASS", `status=${d.status}`);
  } catch (e) { record("210S", "valid complete chain", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 210T deterministic gate evaluation
  try {
    const run = buildRun();
    const a = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    const b = evaluateReleaseSafety({ candidate: CANDIDATE, verificationRun: run, policy: POLICY });
    // Compare everything except decidedAt (which is a wall-clock timestamp).
    const strip = (d: any) => { const { decidedAt, ...rest } = d; return rest; };
    ok(JSON.stringify(strip(a)) === JSON.stringify(strip(b)), `non-deterministic output`);
    record("210T", "deterministic gate evaluation", "PASS", `status=${a.status} identical outputs`);
  } catch (e) { record("210T", "deterministic gate evaluation", "FAIL", e instanceof Error ? e.message : String(e)); }

  finish();
}

function finish(): void {
  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );
  console.log("\n===== Phase 210 summary =====");
  console.log(`PASS: ${counts.PASS}`);
  console.log(`FAIL: ${counts.FAIL}`);
  console.log(`BLOCKED: ${counts.BLOCKED}`);
  console.log(`NOT EXECUTED: ${counts["NOT EXECUTED"]}`);
  if (counts.FAIL > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
