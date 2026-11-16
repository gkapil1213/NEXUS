// scripts/run-safe-regression.ts
// Phase 304: safe, isolated regression runner.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type TestResult = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";

export interface SafeTest {
  file: string;
  category: string;
  timeoutMs?: number;
  expectsOptionalDependency?: boolean;
}

export const SAFE_TESTS: ReadonlyArray<SafeTest> = Object.freeze([
  { file: "test-phase303-kernel-boot-failure.ts", category: "kernel" },
  { file: "test-phase302-dispatch-run-details.ts",  category: "cicd" },
  { file: "test-phase301-bridge-lifecycle.ts",      category: "cicd", expectsOptionalDependency: true },
  { file: "test-phase301-startrun-honesty.ts",      category: "cicd" },
]);

export interface RunReport {
  file: string;
  category: string;
  result: TestResult;
  exitCode: number | null;
  durationMs: number;
  note: string;
}

interface RunOptions { dryRun?: boolean; }

interface ParsedSummary {
  pass: number; fail: number; blocked: number; notExecuted: number; found: boolean;
}

function parseSummary(stdout: string): ParsedSummary {
  const passM = stdout.match(/PASS:\s*(\d+)/) ?? stdout.match(/(\d+)\s*PASS/);
  const failM = stdout.match(/FAIL:\s*(\d+)/) ?? stdout.match(/(\d+)\s*FAIL/);
  const blockM = stdout.match(/BLOCKED:\s*(\d+)/) ?? stdout.match(/(\d+)\s*BLOCKED/);
  const neM = stdout.match(/NOT EXECUTED:\s*(\d+)/) ?? stdout.match(/(\d+)\s*NOT EXECUTED/);
  return {
    pass: passM ? parseInt(passM[1], 10) : 0,
    fail: failM ? parseInt(failM[1], 10) : 0,
    blocked: blockM ? parseInt(blockM[1], 10) : 0,
    notExecuted: neM ? parseInt(neM[1], 10) : 0,
    found: !!(passM || failM || blockM || neM),
  };
}

function classifyChild(
  spawnError: Error | undefined,
  exitCode: number | null,
  stdout: string,
): { result: TestResult; note: string } {
  if (spawnError) return { result: "BLOCKED", note: "spawn error: " + spawnError.message };
  const s = parseSummary(stdout);
  if (s.found) {
    if (s.fail > 0)        return { result: "FAIL",         note: "FAIL=" + s.fail };
    if (s.blocked > 0)     return { result: "BLOCKED",      note: "BLOCKED=" + s.blocked };
    if (s.notExecuted > 0) return { result: "NOT EXECUTED", note: "NE=" + s.notExecuted };
    if (s.pass > 0)        return { result: "PASS",         note: "PASS=" + s.pass };
  }
  if (exitCode === 0) return { result: "PASS", note: "exit 0 (no summary)" };
  return { result: "FAIL", note: "exit " + exitCode + " (no summary)" };
}

export function runSafeRegression(opts: RunOptions = {}): RunReport[] {
  const reports: RunReport[] = [];
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(selfDir, "..");

  for (const t of SAFE_TESTS) {
    const childPath = join(repoRoot, "scripts", t.file);
    const timeoutMs = t.timeoutMs ?? 120_000;

    if (opts.dryRun) {
      reports.push({ file: t.file, category: t.category, result: "NOT EXECUTED", exitCode: null, durationMs: 0, note: "dry-run" });
      continue;
    }

    const tempDbDir = mkdtempSync(join(tmpdir(), "nexus-safe-db-"));
    const tempStateDir = mkdtempSync(join(tmpdir(), "nexus-safe-state-"));
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NEXUS_DB_PATH: join(tempDbDir, "safe.sqlite"),
      NEXUS_PERSISTENCE_ENGINE: "sqlite",
      NEXUS_STATE_DIR: tempStateDir,
    };
    delete childEnv.NEXUS_TEST_GITHUB_TOKEN;

    const startedAt = Date.now();
    const child = spawnSync("node", ["--import", "tsx", childPath], {
      cwd: repoRoot, env: childEnv, encoding: "utf8",
      timeout: timeoutMs, shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const durationMs = Date.now() - startedAt;

    try { rmSync(tempDbDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { }
    try { rmSync(tempStateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { }

    const stdout = String(child.stdout ?? "");
    const c = classifyChild(child.error as Error | undefined, child.status, stdout);
    reports.push({ file: t.file, category: t.category, result: c.result, exitCode: child.status, durationMs, note: c.note });
  }

  return reports;
}

const __entry = process.argv[1];
const __selfName = basename(fileURLToPath(import.meta.url));
const isDirectRun = !!__entry && basename(__entry) === __selfName;

if (isDirectRun) {
  const reports = runSafeRegression();
  const pass = reports.filter((r) => r.result === "PASS").length;
  const fail = reports.filter((r) => r.result === "FAIL").length;
  const blocked = reports.filter((r) => r.result === "BLOCKED").length;
  const ne = reports.filter((r) => r.result === "NOT EXECUTED").length;
  console.log("");
  console.log("=== Phase 304 Safe Regression ===");
  for (const r of reports) {
    console.log("[" + r.result.padEnd(13) + "] " + r.file + "  (" + r.durationMs + "ms)  " + r.note);
  }
  console.log("");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  BLOCKED: " + blocked + "  NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blocked > 0 || ne > 0) ? 2 : 0);
}
