import { spawnSync } from "node:child_process";

const tests = [
  "npx tsx scripts/run-phase5-pass5.ts",
  "npx tsx scripts/run-phase5-pass6.ts",
  "npx tsx scripts/run-phase5-pass7.ts",
  "npx tsx scripts/run-advanced-security-pipeline.ts",
  "npx tsx scripts/run-rollback-e2e.ts",
  "node scripts/verify-pass5-fixed-windows.mjs",
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
  console.error("\nOperations regression suite FAILED");
  process.exit(1);
}

console.log("\n✅ Operations regression suite PASSED");