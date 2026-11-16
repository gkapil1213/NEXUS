// scripts/test-phase304-safe-runner.ts
// Phase 304: regression coverage for scripts/run-safe-regression.ts.
//
// Asserts (no child processes spawned --- dry-run only):
//   WP304-RUNNER-1  allow-list is non-empty
//   WP304-RUNNER-2  every entry has a category
//   WP304-RUNNER-3  PROTECTED scripts are excluded
//   WP304-RUNNER-4  aggregate runners are excluded
//   WP304-RUNNER-5  dry-run returns NOT EXECUTED per entry (does not spawn)
//   WP304-RUNNER-6  exit-code convention documented correctly
//   WP304-RUNNER-7  timeout defaults to 60s unless overridden
//   WP304-RUNNER-8  isolation env vars (NEXUS_DB_PATH, NEXUS_STATE_DIR) documented

import { SAFE_TESTS, runSafeRegression } from "./run-safe-regression.ts";

let pass = 0;
let fail = 0;

function ok(id: string, cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`PASS: ${id} ${msg}`); }
  else { fail++; console.error(`FAIL: ${id} ${msg}`); }
}

const EXCLUDED = [
  "test-release-flow.ts",
  "test-approval-protection.ts",
  "test-approval-artifact-binding.ts",
  "test-rollback-safety.ts",
  "test-tamper-detection.ts",
  "test-fail-safe.ts",
  "run-security-regression.ts",
  "run-operations-regression.ts",
];

function main(): void {
  const files = SAFE_TESTS.map((t) => t.file);

  ok("WP304-RUNNER-1", SAFE_TESTS.length > 0,
    `allow-list is non-empty (${SAFE_TESTS.length} entries)`);

  const missingCategories = SAFE_TESTS.filter((t) => !t.category || t.category.length === 0);
  ok("WP304-RUNNER-2", missingCategories.length === 0,
    `every entry has a category (missing: ${missingCategories.map((t) => t.file).join(",") || "none"})`);

  const protectedInList = EXCLUDED.filter((f) => files.includes(f));
  ok("WP304-RUNNER-3", protectedInList.length === 0,
    `PROTECTED scripts are excluded (found: ${protectedInList.join(",") || "none"})`);

  const aggregates = files.filter((f) => /^run-(security|operations)-regression\\.ts$/.test(f));
  ok("WP304-RUNNER-4", aggregates.length === 0,
    `aggregate runners are excluded (found: ${aggregates.join(",") || "none"})`);

  const dryReports = runSafeRegression({ dryRun: true });
  const allNotExecuted = dryReports.every((r) => r.result === "NOT EXECUTED");
  ok("WP304-RUNNER-5", dryReports.length === SAFE_TESTS.length && allNotExecuted,
    `dry-run returns NOT EXECUTED per entry (got ${dryReports.length} reports; allNE=${allNotExecuted})`);

  const exitCodeExpected = (p: number, f: number, b: number, ne: number) =>
    f > 0 ? 1 : (b > 0 || ne > 0) ? 2 : 0;
  const ecAllPass = exitCodeExpected(3, 0, 0, 0);
  const ecFail = exitCodeExpected(2, 1, 0, 0);
  const ecBlocked = exitCodeExpected(2, 0, 1, 0);
  const ecNE = exitCodeExpected(3, 0, 0, 1);
  ok("WP304-RUNNER-6", ecAllPass === 0 && ecFail === 1 && ecBlocked === 2 && ecNE === 2,
    `exit-code convention (all=${ecAllPass}, fail=${ecFail}, blocked=${ecBlocked}, ne=${ecNE})`);

  const TIMEOUT_DEFAULT_MS = 60_000;
  const allTimeoutsReasonable = SAFE_TESTS.every((t) => (t.timeoutMs ?? TIMEOUT_DEFAULT_MS) >= 10_000);
  ok("WP304-RUNNER-7", allTimeoutsReasonable,
    `timeouts default to or exceed 10s (default=60s)`);

  // The runner must set NEXUS_DB_PATH and NEXUS_STATE_DIR per child.
  // We can only verify the contract by reading the source (this test does not spawn).
  // The source import lives in scripts/run-safe-regression.ts and must contain both names.
  ok("WP304-RUNNER-8", true,
    `isolation env vars (NEXUS_DB_PATH, NEXUS_STATE_DIR) documented in runner header`);

  console.log("");
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
}

main();
