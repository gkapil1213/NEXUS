/**
 * TestAgent — runs REAL tests.
 *
 * A test is only PASSED when a real assertion is evaluated against real
 * workspace/build content and holds. Two modes:
 *  - Structured spec (`nexus.tests.json`): assertions like file_exists /
 *    contains / min_size are evaluated for real against the workspace. This is
 *    genuine verification of the build output.
 *  - External runner (jest/pytest/go test): when the project declares a real
 *    test command but provides no structured spec, we cannot execute the
 *    external runner in this runtime → honest BLOCKED, never fake PASS.
 */

import { StageHalt, type DetectionProfile, type TestResult } from "../types";

interface TestAssertion {
  type: "file_exists" | "contains" | "min_size";
  path: string;
  needle?: string;
  bytes?: number;
}

interface TestSpec {
  suite: string;
  assertions: TestAssertion[];
}

export async function runTests(
  workspace: Record<string, string>,
  profile: DetectionProfile,
): Promise<TestResult> {
  const started = Date.now();
  const specRaw = workspace["nexus.tests.json"];

  if (!specRaw) {
    // The project wants an external runner we cannot execute here.
    if (profile.test_command) {
      throw new StageHalt(
        "blocked",
        `TEST_BLOCKED: the project declares '${profile.test_command}' but no executable 'nexus.tests.json' spec is present, and the external test runner is unavailable in this runtime.`,
      );
    }
    throw new StageHalt("blocked", "TEST_BLOCKED: no test spec (nexus.tests.json) and no test command detected.");
  }

  let spec: TestSpec;
  try {
    spec = JSON.parse(specRaw) as TestSpec;
  } catch {
    throw new StageHalt("failed", "TEST_FAILED: nexus.tests.json is not valid JSON.");
  }
  if (!Array.isArray(spec.assertions) || spec.assertions.length === 0) {
    throw new StageHalt("failed", "TEST_FAILED: test spec has no assertions.");
  }

  const failures: string[] = [];
  let passed = 0;
  for (const a of spec.assertions) {
    const content = workspace[a.path];
    let ok = false;
    if (a.type === "file_exists") ok = content !== undefined;
    else if (a.type === "contains") ok = content !== undefined && a.needle !== undefined && content.includes(a.needle);
    else if (a.type === "min_size") ok = content !== undefined && content.length >= (a.bytes ?? 0);
    if (ok) passed += 1;
    else failures.push(`${a.type} ${a.path}${a.needle ? ` ~ ${a.needle}` : ""}${a.bytes ? ` >= ${a.bytes}B` : ""}`);
  }

  const total = spec.assertions.length;
  const failed = total - passed;
  const result: TestResult = {
    suite: spec.suite ?? "nexus-spec",
    total,
    passed,
    failed,
    duration_ms: Date.now() - started,
    failures,
    exit_code: failed === 0 ? 0 : 1,
    status: failed === 0 ? "PASSED" : "FAILED",
  };
  if (failed > 0) {
    throw new StageHalt("failed", `TEST_FAILED: ${failed}/${total} assertion(s) failed — ${failures.join("; ")}`);
  }
  return result;
}
