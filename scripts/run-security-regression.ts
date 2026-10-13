import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Isolate the security suite from production. Pass1/Pass2/Pass7 construct
// services over openEngine(), which resolves to CONFIG.persistence.dbName
// (nexus.sqlite) unless NEXUS_DB_PATH is set. Every child spawned below
// inherits this environment, so the suite runs against a temp database.
const SECURITY_DB_DIR = mkdtempSync(join(tmpdir(), "nexus-security-"));
const SECURITY_DB_PATH = resolve(SECURITY_DB_DIR, "security.sqlite");
const PRODUCTION_DB_PATH = resolve("nexus.sqlite");

if (SECURITY_DB_PATH.toLowerCase() === PRODUCTION_DB_PATH.toLowerCase()) {
  throw new Error("Refusing to run security tests against the production database");
}

process.env.NEXUS_DB_PATH = SECURITY_DB_PATH;
process.env.NEXUS_PERSISTENCE_ENGINE = "sqlite";

console.log(`Security test database: ${SECURITY_DB_PATH}`);

async function runCommand(cmd: string): Promise<number> {
  console.log(`\n--- Running: ${cmd} ---`);
  const parts = cmd.split(" ");
  const command = parts[0];
  const args = parts.slice(1);

  return new Promise((resolve) => {
    // nosemgrep: spawn-shell-true, detect-child-process
    const child = spawn(command, args, { stdio: "inherit", shell: true, windowsHide: true, env: { ...process.env, NEXUS_DB_PATH: SECURITY_DB_PATH, NEXUS_PERSISTENCE_ENGINE: "sqlite" } });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.error(`Failed to start ${cmd}: ${err}`);
      resolve(1);
    });
  });
}

async function main() {
  const commands = [
    "npx tsx scripts/test-fail-safe.ts",
    "npx tsx scripts/test-tamper-detection.ts",
    "npx tsx scripts/test-approval-artifact-binding.ts",
    "npx tsx scripts/test-approval-protection.ts",
    "npx tsx scripts/test-release-flow.ts",
    "npx tsx scripts/test-rollback-safety.ts",
    "npx tsx scripts/run-phase4-pass1-security.ts",
    "npx tsx scripts/run-phase4-pass2-real-scanners.ts",
    "npx tsx scripts/run-phase4-pass3-signing.ts",
    "npx tsx scripts/run-phase4-pass4-release-gate.ts",
    "npx tsx scripts/run-phase4-pass5-production-decision.ts",
    "npx tsx scripts/run-phase4-pass6-production-enforcement.ts",
    "npx tsx scripts/run-release-integrity-audit.ts",
    "npx tsx scripts/run-release-integrity-enforcement.ts",
    "npx tsx scripts/run-phase4-pass9.ts",
  ];

  let failed = false;
  for (const cmd of commands) {
    const exitCode = await runCommand(cmd);
    if (exitCode !== 0) {
      console.error(`❌ FAILED: ${cmd}`);
      failed = true;
    }
  }

  if (failed) {
    console.error("\nSecurity regression suite FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ Security regression suite PASSED");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
