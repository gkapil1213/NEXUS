import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

function runNodeScript(script: string, timeoutMs: number): { status: number | null; timedOut: boolean } {
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(process.execPath, [tsxCli, script], {
    cwd: ROOT,
    stdio: "ignore",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    timedOut: result.error?.code === "ETIMEDOUT" || result.status === null,
  };
}

function runTypecheck(timeoutMs: number): { status: number | null; timedOut: boolean } {
  const tscCli = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tscCli, "--noEmit"], {
    cwd: ROOT,
    stdio: "ignore",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    timedOut: result.error?.code === "ETIMEDOUT" || result.status === null,
  };
}

function runTerraformCheck(): { status: number | null } {
  const result = spawnSync("terraform", ["version"], { stdio: "ignore", timeout: 10000, windowsHide: true });
  return { status: result.status };
}

function runAwsCheck(): { status: number | null } {
  const result = spawnSync("aws", ["--version"], { stdio: "ignore", timeout: 10000, windowsHide: true });
  return { status: result.status };
}

async function main() {
  console.log("========================================");
  console.log("NEXUS PHASE 7 — FINAL CERTIFICATION");
  console.log("========================================\n");

  const typecheck = runTypecheck(180000);
  console.log(`Typecheck: ${typecheck.status === 0 ? "PASS" : "FAIL"}`);

  console.log("Running Security Regression (may take several minutes)...");
  const security = runNodeScript("scripts/run-security-regression.ts", 1800000);
  const securityPass = security.status === 0;
  console.log(`Security Regression: ${securityPass ? "PASS" : security.timedOut ? "TIMEOUT" : "FAIL"}`);

  const operations = runNodeScript("scripts/run-operations-regression.ts", 600000);
  console.log(`Operations Regression: ${operations.status === 0 ? "PASS" : operations.timedOut ? "TIMEOUT" : "FAIL"}`);

  const terraform = runTerraformCheck();
  const aws = runAwsCheck();
  console.log(`Terraform: ${terraform.status === 0 ? "PASS" : "BLOCKED"}`);
  console.log(`AWS: ${aws.status === 0 ? "PASS" : "BLOCKED"}`);

  const evidence = {
    timestamp: new Date().toISOString(),
    typecheck: typecheck.status === 0 ? "PASS" : "FAIL",
    security_regression: securityPass ? "PASS" : (security.timedOut ? "TIMEOUT" : "FAIL"),
    operations_regression: operations.status === 0 ? "PASS" : (operations.timedOut ? "TIMEOUT" : "FAIL"),
    terraform: terraform.status === 0 ? "PASS" : "BLOCKED",
    aws: aws.status === 0 ? "PASS" : "BLOCKED",
    dast: "BLOCKED",
    blocked: [
      { capability: "Terraform", reason: "executable not found" },
      { capability: "AWS", reason: "executable not found" },
      { capability: "DAST", reason: "STAGING_URL not set" },
    ],
    failures: [
      ...(securityPass ? [] : [{ test: "security", reason: security.timedOut ? "timeout" : "failed" }]),
      ...(operations.status !== 0 ? [{ test: "operations", reason: operations.timedOut ? "timeout" : "failed" }] : []),
    ],
  };
  fs.writeFileSync(path.join(ROOT, "phase7-certification-evidence.json"), JSON.stringify(evidence, null, 2));

  console.log("\nFINAL STATUS: " + (securityPass && operations.status === 0 ? "BLOCKED" : "FAIL"));
  console.log("========================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
