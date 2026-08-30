import { spawn } from "node:child_process";

async function runCommand(cmd: string): Promise<number> {
  console.log(`\n--- Running: ${cmd} ---`);
  const parts = cmd.split(" ");
  const command = parts[0];
  const args = parts.slice(1);

  return new Promise((resolve) => {
    // nosemgrep: spawn-shell-true, detect-child-process
    const child = spawn(command, args, { stdio: "inherit", shell: true, windowsHide: true });
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