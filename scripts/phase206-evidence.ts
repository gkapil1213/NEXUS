// scripts/phase206-evidence.ts
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";

interface Result {
  name: string;
  command: string;
  exit_code: number;
  pass: number;
  fail: number;
  blocked: number;
  status: "PASS" | "FAIL" | "BLOCKED";
}

const SCENARIOS: Array<[string, string]> = [
  ["phase206", "scripts/test-phase206-worker-fencing.ts"],
];

function parseCounts(stdout: string) {
  const m2 = stdout.match(/PASS=(\d+)[\s\S]*?FAIL=(\d+)[\s\S]*?BLOCKED=(\d+)/);
  if (m2) return { pass: Number(m2[1]), fail: Number(m2[2]), blocked: Number(m2[3]), found: true };
  const m = stdout.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?BLOCKED:\s*(\d+)/);
  if (!m) return { pass: 0, fail: 0, blocked: 0, found: false };
  return { pass: Number(m[1]), fail: Number(m[2]), blocked: Number(m[3]), found: true };
}

function runTest(name: string, script: string): Result {
  const cmd = "npx tsx " + script;
  if (!existsSync(script)) return { name, command: cmd, exit_code: -1, pass: 0, fail: 0, blocked: 1, status: "BLOCKED" };
  try {
    const stdout = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd(), env: process.env, timeout: 120_000 });
    const c = parseCounts(stdout);
    const status: Result["status"] = (!c.found || c.fail > 0) ? "FAIL" : (c.blocked > 0 ? "BLOCKED" : "PASS");
    return { name, command: cmd, exit_code: 0, pass: c.pass, fail: c.fail, blocked: c.blocked, status };
  } catch (e: any) {
    const combined = ((e?.stdout ?? "").toString()) + "\n" + ((e?.stderr ?? "").toString());
    const c = parseCounts(combined);
    const status: Result["status"] = c.blocked > 0 ? "BLOCKED" : "FAIL";
    return { name, command: cmd, exit_code: e?.status ?? -1, pass: c.pass, fail: c.fail, blocked: c.blocked, status };
  }
}

function main() {
  const results: Result[] = [];
  for (const [name, script] of SCENARIOS) {
    console.log(`running ${name}...`);
    const r = runTest(name, script);
    console.log(`  ${r.status}  pass=${r.pass} fail=${r.fail} blocked=${r.blocked} exit=${r.exit_code}`);
    results.push(r);
  }
  let commit = "unknown";
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch {}
  const evidence = {
    phase: "206",
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
  if (!existsSync("artifacts/phase206")) mkdirSync("artifacts/phase206", { recursive: true });
  writeFileSync("artifacts/phase206/phase206-evidence.json", JSON.stringify(evidence, null, 2), "utf8");
  console.log("\nwrote artifacts/phase206/phase206-evidence.json");
  console.log(JSON.stringify(evidence.summary, null, 2));
  process.exitCode = evidence.summary.overall === "PASS" ? 0 : 1;
}
main();