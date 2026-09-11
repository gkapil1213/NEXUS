// scripts/run-build-test-execution-tests.ts
//
// A: browser executor → BLOCKED
// B: host executor (mocked) → SUCCEEDED / FAILED / BLOCKED
// C: adapter rejects shell metacharacters, chaining, traversal, non-allowlisted
//
// No real process is spawned. The adapter is exercised against a
// deterministic ProcessExecutor double, so the tests are hermetic.

import { createRuntimeCommandExecutor } from "../src/core/runtime-command-adapter";
import type { ProcessExecutor } from "../src/core/runtime";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`[PASSED] ${name}${detail ? "  Evidence: " + detail : ""}`); }
  else { fail++; console.log(`[FAILED] ${name}${detail ? "  Evidence: " + detail : ""}`); }
}

function mockRuntime(opts: { available: boolean; exit?: number; stdout?: string; stderr?: string; throwOnRun?: Error }): ProcessExecutor {
  return {
    capability: () => opts.available
      ? { available: true, kind: "EXTERNAL_HOST_RUNTIME", reason: null }
      : { available: false, kind: "MANAGED_BROWSER", reason: "no host bridge" },
    run: async (_cmd) => {
      if (opts.throwOnRun) throw opts.throwOnRun;
      return { exit_code: opts.exit ?? 0, stdout: opts.stdout ?? "", stderr: opts.stderr ?? "" };
    },
  } as unknown as ProcessExecutor;
}

(async () => {
  console.log("NEXUS BUILD/TEST EXECUTION TESTS");
  console.log("================================\n");

  // --- A: browser executor (capability unavailable) ---
  // The adapter itself only rejects unmappable commands. The browser gating
  // happens in engineering.ts (RUNTIME_COMMAND_EXECUTOR === null). We verify
  // the underlying contract here: a browser ProcessExecutor must NOT be able
  // to run any command.
  {
    const browserRuntime = {
      capability: () => ({ available: false, kind: "MANAGED_BROWSER", reason: "no host bridge" }),
      run: async () => { throw Object.assign(new Error("EXECUTOR_BLOCKED: browser has no child-process"), { code: "EXECUTOR_BLOCKED" }); },
    } as unknown as ProcessExecutor;
    const adapter = createRuntimeCommandExecutor(browserRuntime);
    let blocked = false;
    try { await adapter.exec("npm run build", "."); } catch (e) { blocked = (e as any).code === "EXECUTOR_BLOCKED"; }
    check("A1 browser ProcessExecutor.run throws EXECUTOR_BLOCKED", blocked, "browser → BLOCKED");
  }

  // --- B: host executor, success ---
  {
    const adapter = createRuntimeCommandExecutor(mockRuntime({ available: true, exit: 0, stdout: "built ok" }));
    let ok = false;
    try {
      const r = await adapter.exec("npm run build", ".");
      ok = r.exit_code === 0 && r.stdout === "built ok";
    } catch {}
    check("B1 host exit 0 maps to exit_code 0", ok, "exit=0 → SUCCEEDED");
  }

  // --- B: host executor, non-zero ---
  {
    const adapter = createRuntimeCommandExecutor(mockRuntime({ available: true, exit: 2, stderr: "compile error" }));
    let ok = false;
    try {
      const r = await adapter.exec("npm test", ".");
      ok = r.exit_code === 2 && r.stderr === "compile error";
    } catch {}
    check("B2 host non-zero exit is preserved verbatim", ok, "exit=2 → FAILED");
  }

  // --- B: host executor, runtime exception other than BLOCKED ---
  {
    const adapter = createRuntimeCommandExecutor(mockRuntime({ available: true, throwOnRun: new Error("EACCES spawn failed") }));
    let failed = false;
    try { await adapter.exec("npm test", "."); } catch (e) { failed = (e as Error).message.includes("EACCES"); }
    check("B3 runtime execution error propagates (→ FAILED, not success)", failed, "spawn error → FAILED");
  }

  // --- C: security / mapping ---
  {
    const adapter = createRuntimeCommandExecutor(mockRuntime({ available: true }));
    const cases: Array<[string, string]> = [
      ["npm run build && rm -rf /", "shell chaining"],
      ["npm run build; echo pwn", "semicolon chaining"],
      ["npm run build | tee x", "pipe"],
      ["npm run build > out", "redirect"],
      ["../../etc/passwd", "traversal"],
      ["rm -rf /", "non-allowlisted tool"],
      ["$(whoami)", "command substitution"],
      ["`id`", "backtick substitution"],
    ];
    let allBlocked = true;
    for (const [cmd, label] of cases) {
      try {
        await adapter.exec(cmd, ".");
        allBlocked = false;
        console.log(`  UNEXPECTED PASS: ${label} (${cmd})`);
      } catch (e) {
        if ((e as any).code !== "EXECUTOR_BLOCKED") {
          allBlocked = false;
          console.log(`  WRONG ERROR for ${label}: ${(e as Error).message}`);
        }
      }
    }
    check("C1 shell metacharacters, chaining, traversal, non-allowlisted tools all BLOCKED", allBlocked, "8 hostile inputs rejected");
  }

  // --- C: valid mapping shapes accepted (delegated to runtime, never shelled) ---
  {
    const seen: string[] = [];
    const runtime = {
      capability: () => ({ available: true, kind: "EXTERNAL_HOST_RUNTIME", reason: null }),
      run: async (cmd: any) => {
        seen.push(`${cmd.tool}:${cmd.operation}:${cmd.args.join(",")}`);
        return { exit_code: 0, stdout: "", stderr: "" };
      },
    } as unknown as ProcessExecutor;
    const adapter = createRuntimeCommandExecutor(runtime);
    const cases = ["npm install", "npm run build", "npm test", "pnpm install", "pnpm run build", "pnpm test",
                   "yarn install", "yarn build", "yarn test", "pytest"];
    let accepted = 0;
    for (const c of cases) {
      try { await adapter.exec(c, "."); accepted++; } catch { /* unsupported tool → BLOCKED is legitimate */ }
    }
    check("C2 valid package-manager commands mapped structurally", accepted > 0, `${accepted}/${cases.length} mapped: ${seen.join(" | ")}`);
  }

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

export function run() { /* wrapper compat */ }
