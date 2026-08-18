#!/usr/bin/env node
/**
 * NEXUS Phase 1 regression gate (scripts/verify-phase1).
 *
 * Runs what this environment can actually execute and reports BLOCKED for
 * what requires a runtime it does not have — never faking a pass:
 *
 *   1. TypeScript compilation      (npx tsc --noEmit)
 *   2. Production build            (npm run build)
 *   3. In-browser verification     → BLOCKED here; run in-app:
 *      Control Plane → "Run Phase 1 verification"
 *
 * Exit code 0 only when every executable gate passes.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const results = [];

function run(label, cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  const ok = res.status === 0;
  results.push({ label, status: ok ? "PASS" : "FAIL" });
  return ok;
}

console.log("NEXUS Phase 1 verification");
console.log("==========================");

let allOk = true;

if (existsSync("tsconfig.json")) {
  allOk = run("TypeScript compilation", "npx", ["tsc", "--noEmit"]) && allOk;
} else {
  results.push({ label: "TypeScript compilation", status: "BLOCKED (no tsconfig.json)" });
}

if (existsSync("package.json")) {
  allOk = run("Production build", "npm", ["run", "build"]) && allOk;
} else {
  results.push({ label: "Production build", status: "BLOCKED (no package.json)" });
}

results.push({
  label: "In-browser Phase 1 suite (kernel/db/orchestration/security)",
  status: "BLOCKED — requires a browser runtime. Open the app → Control Plane → Run Phase 1 verification",
});

console.log("");
for (const r of results) console.log(`[${r.status.startsWith("PASS") ? "PASS" : r.status.startsWith("FAIL") ? "FAIL" : "BLOCKED"}] ${r.label}`);

const failed = results.some((r) => r.status === "FAIL");
process.exit(failed ? 1 : 0);
