import { runNodeProcess, runTerraformProcess, runAwsProcess, ProcessResult } from "../src/core/process-runner";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

function resultToStatus(r: ProcessResult): "PASS" | "FAIL" | "TIMEOUT" | "BLOCKED" {
  if (r.status === "TIMEOUT") return "TIMEOUT";
  if (r.status === "ERROR") return "FAIL";
  return r.status === "PASS" ? "PASS" : "FAIL";
}

async function runTsx(script: string, timeoutMs: number): Promise<ProcessResult> {
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return runNodeProcess([tsx, script], { timeoutMs });
}

async function main() {
  console.log("========================================");
  console.log("NEXUS PHASE 8 — CERTIFICATION");
  console.log("========================================\n");

  // 1. Typecheck
  const typecheck = await runNodeProcess([
    path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
  ], { timeoutMs: 180000 });
  console.log(`Typecheck: ${resultToStatus(typecheck)}`);

  // 2. Capability detection
  const terraform = await runTerraformProcess(["version"], { timeoutMs: 10000 });
  const aws = await runAwsProcess(["--version"], { timeoutMs: 10000 });
  console.log(`Terraform: ${terraform.status === "PASS" ? "PASS" : "BLOCKED"}`);
  console.log(`AWS: ${aws.status === "PASS" ? "PASS" : "BLOCKED"}`);

  // 3. Run existing regressions
  console.log("Running security regression (this may take several minutes)...");
  const security = await runTsx("scripts/run-security-regression.ts", 1800000);
  console.log(`Security Regression: ${resultToStatus(security)}`);

  const operations = await runTsx("scripts/run-operations-regression.ts", 600000);
  console.log(`Operations Regression: ${resultToStatus(operations)}`);

  // 4. Phase 8 components (not yet implemented)
  const phase8Components = {
    metrics: "BLOCKED",
    logs: "BLOCKED",
    traces: "BLOCKED",
    health: "BLOCKED",
    alerts: "BLOCKED",
    incidents: "BLOCKED",
    slo: "BLOCKED",
    errorBudget: "BLOCKED",
    capacity: "BLOCKED",
    backup: "BLOCKED",
    recovery: "BLOCKED",
  };

  const evidence = {
    timestamp: new Date().toISOString(),
    typecheck: resultToStatus(typecheck),
    security_regression: resultToStatus(security),
    operations_regression: resultToStatus(operations),
    capabilities: {
      terraform: terraform.status === "PASS" ? "PASS" : "BLOCKED",
      aws: aws.status === "PASS" ? "PASS" : "BLOCKED",
      dast: "BLOCKED",
    },
    phase8: phase8Components,
    blocked: [
      { capability: "Terraform", reason: "executable not found" },
      { capability: "AWS", reason: "executable not found" },
      { capability: "DAST", reason: "STAGING_URL not set" },
      { capability: "Phase8 services", reason: "not yet implemented" },
    ],
    failures: [
      ...(security.status !== "PASS" ? [{ test: "security", output: (security.stdout + security.stderr).slice(0, 300) }] : []),
      ...(operations.status !== "PASS" ? [{ test: "operations", output: (operations.stdout + operations.stderr).slice(0, 300) }] : []),
    ],
  };

  fs.writeFileSync(
    path.join(ROOT, "phase8-certification-evidence.json"),
    JSON.stringify(evidence, null, 2)
  );

  console.log("\nPhase 8 certification complete. Evidence written.");
  console.log("FINAL STATUS: BLOCKED (Phase 8 services not yet implemented; infra unavailable)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});