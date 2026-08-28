import { spawnSync } from "node:child_process";

const tests = [
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
];

let failed = false;

for (const test of tests) {
  console.log(`\n--- Running: ${test} ---`);
  const [cmd, ...args] = test.split(" ");
  let result;
  if (process.platform === "win32") {
    result = spawnSync(process.env.ComSpec || "cmd.exe", ["/c", cmd, ...args], {
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
  } else {
    result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  }

  if (result.status !== 0) {
    failed = true;
    console.error(`❌ FAILED: ${test}`);
  }
}

if (failed) {
  console.error("\nSecurity regression suite FAILED");
  process.exit(1);
}

console.log("\n✅ Security regression suite PASSED");