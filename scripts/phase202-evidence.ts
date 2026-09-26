// scripts/phase202-evidence.ts
// Produces artifacts/phase202/phase202-evidence.json from actual test runs.

import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";

interface Result {
  name: string;
  command: string;
  exit_code: number;
  pass: number;
  fail: number;
  blocked: number;
  status: "PASS" | "FAIL" | "BLOCKED";
}

function runTest(name: string, script: string, cwd: string): Promise<Result> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", script], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    c.stdout.on("data", (d) => { stdout += d.toString(); });
    c.stderr.on("data", (d) => { stdout += d.toString(); });
    c.on("exit", (code) => {
      const m = stdout.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?BLOCKED:\s*(\d+)/);
      const pass = m ? Number(m[1]) : 0;
      const fail = m ? Number(m[2]) : 0;
      const blocked = m ? Number(m[3]) : 0;
      const status: Result["status"] = (code === 0 && fail === 0 && blocked === 0) ? "PASS" : (blocked > 0 ? "BLOCKED" : "FAIL");
      resolve({ name, command: "npx tsx " + script, exit_code: code ?? -1, pass, fail, blocked, status });
    });
  });
}

async function main() {
  const cwd = process.cwd();
  const results: Result[] = [];

  const scripts = [
    ["phase202a", "scripts/test-phase202-durable-admission.ts"],
    ["phase202b", "scripts/test-phase202b-retry-eligibility.ts"],
    ["phase202c", "scripts/test-phase202c-concurrency.ts"],
    ["phase202d", "scripts/test-phase202d-shared-admission.ts"],
    ["phase202e", "scripts/test-phase202e-admission-stress.ts"],
  ];

  for (const [name, script] of scripts) {
    if (!existsSync(script)) {
      results.push({ name, command: "npx tsx " + script, exit_code: -1, pass: 0, fail: 0, blocked: 1, status: "BLOCKED" });
      continue;
    }
    console.log(`running ${name}...`);
    const r = await runTest(name, script, cwd);
    console.log(`  ${r.status}  pass=${r.pass} fail=${r.fail} blocked=${r.blocked}`);
    results.push(r);
  }

  const commit = execSync("git rev-parse HEAD").toString().trim();

  const evidence = {
    phase: "202",
    timestamp: new Date().toISOString(),
    commit,
    results,
    summary: {
      total_pass: results.reduce((a, r) => a + r.pass, 0),
      total_fail: results.reduce((a, r) => a + r.fail, 0),
      total_blocked: results.reduce((a, r) => a + r.blocked, 0),
      overall: results.every((r) => r.status === "PASS") ? "PASS" : "FAIL",
    },
  };

  if (!existsSync("artifacts/phase202")) mkdirSync("artifacts/phase202", { recursive: true });
  writeFileSync("artifacts/phase202/phase202-evidence.json", JSON.stringify(evidence, null, 2), "utf8");
  console.log("\nwrote artifacts/phase202/phase202-evidence.json");
  console.log(JSON.stringify(evidence.summary, null, 2));
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });