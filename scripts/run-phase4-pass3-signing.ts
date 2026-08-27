import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";

async function main() {
  const engine = await openEngine();
  const api = new SecurityApi(engine);
  const runner = new SecurityScannerRunner(engine, api);

  const artifactDigest = "a".repeat(64); // 64 hex chars, sha256-like

  const execution = await api.startExecution(
    "proj_phase4_pass3",
    "exec_pass3",
    "feedbeef",
    artifactDigest,
    "rel_pass3",
  );
  console.log(`✅ Security execution started: ${execution.id}`);

  const summary = await runner.runAll(
    "exec_pass3",
    "proj_phase4_pass3",
    "feedbeef",
    artifactDigest,
    "rel_pass3",
  );

  console.log("\nScanner results:");
  for (const r of summary.results) {
    console.log(
      `  ${r.scanner.padEnd(15)} ${r.status.padEnd(8)} findings=${r.findings_count} time=${r.duration_ms}ms${r.blocked_reason ? ` blocked_reason=${r.blocked_reason}` : ""}`,
    );
  }

  const signatureResult = summary.results.find((r) => r.scanner === "signature");
  if (!signatureResult) {
    console.error("❌ No signature scanner result found");
    process.exit(1);
  }

  if (signatureResult.status === "PASS") {
    console.log("\n✅ Phase 4 Pass 3: Real artifact signing + verification PASSED");
    process.exit(0);
  } else {
    console.error(`\n❌ Phase 4 Pass 3 FAILED: signature status = ${signatureResult.status}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});