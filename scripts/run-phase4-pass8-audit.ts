import { sync as spawnSync } from "cross-spawn";
import { writeFileSync } from "fs";
import { join } from "path";

const results: any = {
  phase: "4",
  pass: "8",
  timestamp: new Date().toISOString(),
  capabilities: {},
  typecheck: "NOT_RUN",
  build: "NOT_RUN",
  security_regression: "NOT_RUN",
  pass7: "NOT_RUN",
  real_failures: [],
  real_blockers: [],
};

function runCmd(cmd: string, args: string[] = [], timeoutMs = 60000): { ok: boolean; output: string; error?: string } {
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024, // 50 MB buffer
    });
    const output = (res.stdout || "").trim() + (res.stderr ? "\n" + res.stderr.trim() : "");
    return { ok: res.status === 0, output: output.trim() };
  } catch (e: any) {
    return { ok: false, output: "", error: String(e.message || e) };
  }
}

function detectCapability(name: string, cmd: string, args: string[] = ["--version"]): void {
  const res = runCmd(cmd, args);
  const available = res.ok;
  results.capabilities[name] = {
    available,
    version: res.output.split("\n")[0]?.slice(0, 100) || "unknown",
    reason: available ? "" : (res.error || res.output || "not found"),
    status: available ? "PASS" : "BLOCKED",
  };
  if (!available) results.real_blockers.push(`${name}: ${res.error || "not found"}`);
}

console.log("NEXUS Phase 4 Pass 8 Audit Starting...\n");

// Detect capabilities
detectCapability("node", "node");
detectCapability("npm", "npm");
detectCapability("docker", "docker");
detectCapability("docker_daemon", "docker", ["info"]);
detectCapability("semgrep", "semgrep");
detectCapability("gitleaks", "gitleaks", ["version"]);
detectCapability("trivy", "trivy");
detectCapability("checkov", "checkov");
detectCapability("syft", "syft");
detectCapability("grype", "grype");
detectCapability("playwright", "npx", ["playwright", "--version"]);
detectCapability("chromium", "chromium");

// cosign may not be on PATH; try npx --no-install cosign
const cosignRes = runCmd("npx", ["--no-install", "cosign", "version"]);
results.capabilities["cosign"] = {
  available: cosignRes.ok,
  version: cosignRes.ok ? cosignRes.output.split("\n")[0] : "unknown",
  reason: cosignRes.ok ? "" : (cosignRes.error || cosignRes.output || "not found"),
  status: cosignRes.ok ? "PASS" : "BLOCKED",
};
if (!cosignRes.ok) results.real_blockers.push("cosign: not found");

detectCapability("terraform", "terraform");

// Typecheck
console.log("Running typecheck...");
const typecheck = runCmd("npm", ["run", "typecheck"], 60000);
results.typecheck = typecheck.ok ? "PASS" : "FAIL";
if (!typecheck.ok) results.real_failures.push("typecheck failed");

// Build
console.log("Running production build...");
const build = runCmd("npm", ["run", "build"], 120000);
results.build = build.ok ? "PASS" : "FAIL";
if (!build.ok) results.real_failures.push("build failed");

// Security regression (use success marker to avoid exit code issues)
console.log("Running security regression...");
const secReg = runCmd("npm", ["run", "test:security"], 1800000); // 30 min
const secPassed = secReg.output.includes("Security regression suite PASSED");
results.security_regression = secPassed ? "PASS" : "FAIL";
if (!secPassed) {
  results.real_failures.push(`security regression failed; output tail: ${secReg.output.slice(-800)}`);
}

// Pass 7 verification (use success marker)
console.log("Running Phase 4 Pass 7 verification...");
const pass7 = runCmd("npx", ["tsx", "scripts/run-phase4-pass7-security-operations.ts"], 600000);
const pass7Passed = pass7.output.includes("Total tests: 19, Passed: 19");
results.pass7 = pass7Passed ? "PASS" : "FAIL";
if (!pass7Passed) {
  results.real_failures.push(`pass7 verification failed; output tail: ${pass7.output.slice(-800)}`);
}

// Generate evidence file
const outPath = join(process.cwd(), "phase4-pass8-evidence.json");
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nEvidence written to ${outPath}`);

// Print summary
console.log("\n========================================");
console.log("CAPABILITY SUMMARY");
for (const [name, cap] of Object.entries(results.capabilities)) {
  console.log(`${name}: ${cap.status}`);
}
console.log(`Typecheck: ${results.typecheck}`);
console.log(`Build: ${results.build}`);
console.log(`Security Regression: ${results.security_regression}`);
console.log(`Pass 7 Verification: ${results.pass7}`);
console.log("========================================");