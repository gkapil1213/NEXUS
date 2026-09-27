// scripts/test-phase209-verification-integrity.ts
// Phase 209 verification-integrity test suite (209A-209O).
// Drives the real verification-integrity and verification-evidence modules.
// Fails closed on any integrity invariant violation.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  computeVerdict, digestResults, evidenceDigest, canonicalize, sha256,
  type VerificationRun, type TestResult,
} from "../src/core/verification-integrity";
import { verifyStoredEvidence } from "../src/core/verification-evidence";
import { PHASE_208, getManifest } from "../src/core/verification-manifest";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

// Build a synthetic VerificationRun with all-208 tests PASS.
function syntheticPhase208(overrides: Partial<VerificationRun> = {}): VerificationRun {
  const results: TestResult[] = PHASE_208.requiredTestIds.map((id) => ({
    testId: id, name: "t-" + id, status: "PASS", note: "synthetic",
  }));
  const r: VerificationRun = {
    runId: "synthetic-run-001",
    phase: 208,
    suite: "synthetic-suite",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    status: "PASS",
    requestedTestCount: 20,
    executedTestCount: 20,
    passCount: 20,
    failCount: 0,
    blockedCount: 0,
    notExecutedCount: 0,
    unverifiedCount: 0,
    exitCode: 0,
    repositoryCommit: "0000000000000000000000000000000000000000",
    repositoryBranch: "synthetic",
    testScript: PHASE_208.testScript,
    results,
    resultDigest: digestResults(results),
    ...overrides,
  };
  return r;
}

async function main(): Promise<void> {
  // ---- 209A manifest validation ----
  try {
    const m = getManifest(208);
    ok(m.requiredTestIds.length === 20, `expected 20 ids, got ${m.requiredTestIds.length}`);
    ok(m.requiredTestIds[0] === "208A", "first id not 208A");
    ok(m.requiredTestIds[19] === "208T", "last id not 208T");
    let threw = false;
    try { getManifest(9999); } catch { threw = true; }
    ok(threw, "unknown phase should throw");
    record("209A", "manifest validation", "PASS",
      `208 has 20 required ids; unknown phase rejected`);
  } catch (e) { record("209A", "manifest validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209B actual-result aggregation ----
  try {
    const results: TestResult[] = PHASE_208.requiredTestIds.map((id) => ({
      testId: id, name: id, status: "PASS", note: "",
    }));
    const out = computeVerdict({
      results, manifest: PHASE_208, exitCode: 0,
      repositoryCommit: "abc", repositoryBranch: "main",
      startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z",
      runId: "r-1",
    });
    ok(out.verdict === "PASS", `verdict=${out.verdict}`);
    ok(out.run.passCount === 20, `passCount=${out.run.passCount}`);
    ok(out.run.failCount === 0, `failCount=${out.run.failCount}`);
    record("209B", "actual-result aggregation", "PASS",
      `verdict=${out.verdict} pass=${out.run.passCount}`);
  } catch (e) { record("209B", "actual-result aggregation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209C missing test detection ----
  try {
    const results: TestResult[] = PHASE_208.requiredTestIds
      .filter((id) => id !== "208S")
      .map((id) => ({ testId: id, name: id, status: "PASS", note: "" }));
    const out = computeVerdict({
      results, manifest: PHASE_208, exitCode: 0,
      repositoryCommit: "abc", repositoryBranch: "main",
      startedAt: "a", completedAt: "b", runId: "r-2",
    });
    ok(out.verdict !== "PASS", `missing test should not PASS: ${out.verdict}`);
    ok(out.run.notExecutedCount >= 1, `notExecutedCount=${out.run.notExecutedCount}`);
    ok(out.reasons.some((r) => r.includes("MISSING_REQUIRED:208S")),
       `missing reason not present: ${out.reasons.join("|")}`);
    record("209C", "missing test detection", "PASS",
      `missing=208S notExecuted=${out.run.notExecutedCount}`);
  } catch (e) { record("209C", "missing test detection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209D unexpected test detection ----
  try {
    const results: TestResult[] = PHASE_208.requiredTestIds.map((id) => ({
      testId: id, name: id, status: "PASS", note: "",
    }));
    results.push({ testId: "999Z", name: "injected", status: "PASS", note: "" });
    const out = computeVerdict({
      results, manifest: PHASE_208, exitCode: 0,
      repositoryCommit: "abc", repositoryBranch: "main",
      startedAt: "a", completedAt: "b", runId: "r-3",
    });
    ok(out.verdict !== "PASS", `unexpected test should prevent PASS: ${out.verdict}`);
    ok(out.reasons.some((r) => r.includes("UNEXPECTED_TEST:999Z")),
       `unexpected reason not present: ${out.reasons.join("|")}`);
    record("209D", "unexpected test detection", "PASS",
      `unexpected=999Z blocked from PASS`);
  } catch (e) { record("209D", "unexpected test detection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209E result hashing determinism ----
  try {
    const base: TestResult[] = [
      { testId: "A", name: "a", status: "PASS", note: "x" },
      { testId: "B", name: "b", status: "FAIL", note: "y" },
      { testId: "C", name: "c", status: "BLOCKED", note: "z" },
    ];
    const shuffled: TestResult[] = [base[2], base[0], base[1]];
    const d1 = digestResults(base);
    const d2 = digestResults(shuffled);
    ok(d1 === d2, `digest not order-independent: ${d1} vs ${d2}`);
    const tampered: TestResult[] = base.map((r) => r.testId === "B" ? { ...r, status: "PASS" } : r);
    const d3 = digestResults(tampered);
    ok(d3 !== d1, `digest did not change on status change`);
    record("209E", "result hashing determinism", "PASS",
      `digest=${d1.slice(0, 16)}... stable across order; changed on status`);
  } catch (e) { record("209E", "result hashing determinism", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209F evidence hashing determinism + sensitivity ----
  try {
    const r1 = syntheticPhase208();
    const d1 = evidenceDigest(r1);
    const r2 = syntheticPhase208();
    const d2 = evidenceDigest(r2);
    ok(d1 === d2, `evidence digest not deterministic: ${d1} vs ${d2}`);
    // Change one result's status -> digest must change
    const tampered = { ...r1, results: r1.results.map((x) => x.testId === "208A" ? { ...x, status: "FAIL" as const } : x) };
    const d3 = evidenceDigest(tampered);
    ok(d3 !== d1, `evidence digest did not change on result change`);
    record("209F", "evidence hashing determinism", "PASS",
      `digest=${d1.slice(0, 16)}... stable across identical runs; changes on edit`);
  } catch (e) { record("209F", "evidence hashing determinism", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209G commit mismatch ----
  try {
    const r = syntheticPhase208({ repositoryCommit: "abc123" });
    const digest = evidenceDigest(r);
    const stored = { ...r, evidenceDigest: digest };
    const check = verifyStoredEvidence(stored);
    ok(check.verdict === "VERIFIED_PASS", `fresh evidence should VERIFIED_PASS, got ${check.verdict}`);
    // Now mutate the commit -> digest must no longer match
    const tampered = { ...stored, repositoryCommit: "def456" };
    const tamperedCheck = verifyStoredEvidence(tampered);
    ok(tamperedCheck.verdict === "TAMPERED", `commit mismatch should be TAMPERED, got ${tamperedCheck.verdict}`);
    record("209G", "commit mismatch detection", "PASS",
      `VERIFIED_PASS -> TAMPERED on commit change`);
  } catch (e) { record("209G", "commit mismatch detection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209H tamper detection (PASS count edit) ----
  try {
    const r = syntheticPhase208();
    const digest = evidenceDigest(r);
    const stored = { ...r, evidenceDigest: digest };
    const cleanCheck = verifyStoredEvidence(stored);
    ok(cleanCheck.verdict === "VERIFIED_PASS", `clean should VERIFIED_PASS: ${cleanCheck.verdict}`);

    // Scenario B: change PASS count in the JSON but keep digests from original
    const tampered = { ...stored, passCount: 19, failCount: 1 };
    const tamperedCheck = verifyStoredEvidence(tampered);
    ok(tamperedCheck.verdict === "TAMPERED", `count edit should TAMPERED, got ${tamperedCheck.verdict}`);
    ok(tamperedCheck.reasons.includes("EVIDENCE_DIGEST_MISMATCH"),
       `missing EVIDENCE_DIGEST_MISMATCH: ${tamperedCheck.reasons.join("|")}`);
    record("209H", "tamper detection (PASS count edit)", "PASS",
      `counts edited -> TAMPERED / EVIDENCE_DIGEST_MISMATCH`);
  } catch (e) { record("209H", "tamper detection (PASS count edit)", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209I result digest tamper ----
  try {
    const r = syntheticPhase208();
    const digest = evidenceDigest(r);
    const stored = { ...r, evidenceDigest: digest };
    // Change a single test's status in the stored JSON without regenerating digests
    const tampered = {
      ...stored,
      results: stored.results.map((x) => x.testId === "208J" ? { ...x, status: "FAIL" } : x),
    };
    const check = verifyStoredEvidence(tampered);
    ok(check.verdict === "TAMPERED", `result edit should TAMPERED, got ${check.verdict}`);
    ok(check.reasons.includes("RESULT_DIGEST_MISMATCH"),
       `missing RESULT_DIGEST_MISMATCH: ${check.reasons.join("|")}`);
    record("209I", "result digest tamper", "PASS",
      `single-result edit -> TAMPERED / RESULT_DIGEST_MISMATCH`);
  } catch (e) { record("209I", "result digest tamper", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209J duplicate result detection ----
  try {
    const results: TestResult[] = PHASE_208.requiredTestIds.map((id) => ({
      testId: id, name: id, status: "PASS", note: "",
    }));
    // Inject duplicate for 208A
    results.push({ testId: "208A", name: "dupe", status: "FAIL", note: "" });
    const out = computeVerdict({
      results, manifest: PHASE_208, exitCode: 0,
      repositoryCommit: "abc", repositoryBranch: "main",
      startedAt: "a", completedAt: "b", runId: "r-dup",
    });
    ok(out.verdict !== "PASS", `duplicate should not PASS: ${out.verdict}`);
    ok(out.reasons.some((r) => r.startsWith("DUPLICATE_RESULT:")),
       `missing DUPLICATE_RESULT reason: ${out.reasons.join("|")}`);
    record("209J", "duplicate result detection", "PASS",
      `duplicate 208A -> ${out.verdict}`);
  } catch (e) { record("209J", "duplicate result detection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209K non-zero exit code -> FAIL ----
  try {
    const results: TestResult[] = PHASE_208.requiredTestIds.map((id) => ({
      testId: id, name: id, status: "PASS", note: "",
    }));
    const out = computeVerdict({
      results, manifest: PHASE_208, exitCode: 1,
      repositoryCommit: "abc", repositoryBranch: "main",
      startedAt: "a", completedAt: "b", runId: "r-exit",
    });
    ok(out.verdict === "FAIL", `nonzero exit should FAIL, got ${out.verdict}`);
    ok(out.reasons.some((r) => r.startsWith("NONZERO_EXIT:")),
       `missing NONZERO_EXIT reason: ${out.reasons.join("|")}`);
    record("209K", "non-zero exit code handling", "PASS",
      `exit=1 -> FAIL / NONZERO_EXIT:1`);
  } catch (e) { record("209K", "non-zero exit code handling", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209L BLOCKED handling ----
  try {
    const results: TestResult[] = PHASE_208.requiredTestIds.map((id) => ({
      testId: id, name: id, status: id === "208D" ? "BLOCKED" as const : "PASS" as const, note: "",
    }));
    const out = computeVerdict({
      results, manifest: PHASE_208, exitCode: 0,
      repositoryCommit: "abc", repositoryBranch: "main",
      startedAt: "a", completedAt: "b", runId: "r-blocked",
    });
    ok(out.verdict === "BLOCKED", `one BLOCKED should BLOCK, got ${out.verdict}`);
    ok(out.run.blockedCount === 1, `blockedCount=${out.run.blockedCount}`);
    record("209L", "BLOCKED handling", "PASS",
      `one BLOCKED -> verdict=BLOCKED blockedCount=1`);
  } catch (e) { record("209L", "BLOCKED handling", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209M UNVERIFIED / NOT_EXECUTED handling ----
  try {
    const results: TestResult[] = PHASE_208.requiredTestIds
      .filter((id) => id !== "208T")
      .map((id) => ({ testId: id, name: id, status: "PASS" as const, note: "" }));
    const out = computeVerdict({
      results, manifest: PHASE_208, exitCode: 0,
      repositoryCommit: "abc", repositoryBranch: "main",
      startedAt: "a", completedAt: "b", runId: "r-ne",
    });
    ok(out.verdict === "UNVERIFIED", `missing test should UNVERIFIED, got ${out.verdict}`);
    ok(out.run.notExecutedCount === 1, `notExecutedCount=${out.run.notExecutedCount}`);
    ok(out.run.unverifiedCount === 0, `unverifiedCount should stay 0 for missing-only: ${out.run.unverifiedCount}`);
    record("209M", "NOT_EXECUTED handling", "PASS",
      `missing 208T -> UNVERIFIED notExecuted=1`);
  } catch (e) { record("209M", "NOT_EXECUTED handling", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209N canonical + sha256 correctness ----
  try {
    const a = canonicalize({ b: 2, a: 1 });
    const b = canonicalize({ a: 1, b: 2 });
    ok(a === b, `canonicalize not key-order independent: ${a} vs ${b}`);
    ok(canonicalize([3, 2, 1]) === "[3,2,1]", "array order must be preserved");
    const h1 = sha256("hello");
    const h2 = sha256("hello");
    const h3 = sha256("hello!");
    ok(h1 === h2, "sha256 not deterministic");
    ok(h1 !== h3, "sha256 not sensitive to input");
    ok(h1 === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
       `sha256("hello") mismatch: ${h1}`);
    record("209N", "canonical + sha256 correctness", "PASS",
      `canonicalize key-order independent; sha256("hello") matches standard vector`);
  } catch (e) { record("209N", "canonical + sha256 correctness", "FAIL", e instanceof Error ? e.message : String(e)); }

  // ---- 209O concurrent verification verdicts (no contradictory PASS) ----
  try {
    // Two computeVerdict calls against identical results+manifest must agree.
    // This is the same-process determinism check. Cross-process coordination
    // is not required because the verdict is a pure function of (results,
    // manifest, exitCode, commit).
    const results: TestResult[] = PHASE_208.requiredTestIds.map((id) => ({
      testId: id, name: id, status: "PASS", note: "",
    }));
    const input = {
      results, manifest: PHASE_208, exitCode: 0,
      repositoryCommit: "commit-abc", repositoryBranch: "main",
      startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z",
      runId: "concurrent-1",
    } as const;
    const [a, b, c] = await Promise.all([
      Promise.resolve().then(() => computeVerdict({ ...input })),
      Promise.resolve().then(() => computeVerdict({ ...input })),
      Promise.resolve().then(() => computeVerdict({ ...input })),
    ]);
    ok(a.verdict === "PASS" && b.verdict === "PASS" && c.verdict === "PASS",
       `not all PASS: ${a.verdict}/${b.verdict}/${c.verdict}`);
    ok(a.run.resultDigest === b.run.resultDigest && b.run.resultDigest === c.run.resultDigest,
       "result digests diverged across concurrent verdicts");
    ok(evidenceDigest(a.run) === evidenceDigest(b.run) && evidenceDigest(b.run) === evidenceDigest(c.run),
       "evidence digests diverged across concurrent verdicts");
    record("209O", "concurrent verification determinism", "PASS",
      `3 concurrent verdicts all PASS with identical digests`);
  } catch (e) { record("209O", "concurrent verification determinism", "FAIL", e instanceof Error ? e.message : String(e)); }

  finish();
}

function finish(): void {
  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );
  console.log("\n===== Phase 209 summary =====");
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
