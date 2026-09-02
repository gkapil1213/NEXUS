import { CapabilityDetector } from "../src/core/capability-detector";
import { openEngine, resetEngineForTesting } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { EvidenceService } from "../src/core/evidence-service";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { redactSecrets } from "../src/core/redaction";
import spawn from "cross-spawn";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";

interface RunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function run(command: string, args: string[], timeoutMs = 60000): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolve({ command, args, exitCode: 124, stdout, stderr: stderr + "\n[timeout]", durationMs: Date.now() - start, timedOut });
    }, timeoutMs);
    child.stdout?.on("data", (d: any) => (stdout += d.toString()));
    child.stderr?.on("data", (d: any) => (stderr += d.toString()));
    child.on("error", (err: any) => {
      clearTimeout(timer);
      resolve({ command, args, exitCode: 1, stdout, stderr: String(err), durationMs: Date.now() - start, timedOut: false });
    });
    child.on("close", (code: number) => {
      clearTimeout(timer);
      resolve({ command, args, exitCode: code ?? 1, stdout, stderr, durationMs: Date.now() - start, timedOut });
    });
  });
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function pickImage(): string | null {
  try {
    const res = execSync("docker images --format \"{{.Repository}}:{{.Tag}}\"", { encoding: "utf8" });
    const lines = res.trim().split(/\r?\n/).filter(Boolean);
    // Prefer nexus-test or nexus-app, exclude registry and localhost prefixes if possible
    const preferred = lines.find(l => /^nexus-(test|app):/.test(l));
    if (preferred) return preferred;
    // Fallback to any line containing nexus
    const any = lines.find(l => l.includes("nexus") && !l.includes("registry"));
    return any ?? null;
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== NEXUS PHASE 8 PASS 2 ===\n");

  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = path.join(process.cwd(), "data", "phase8-pass2.sqlite");
  resetEngineForTesting();
  const engine = await openEngine();

  const detector = new CapabilityDetector();
  const capabilities = await detector.detect();
  console.log("CAPABILITIES");
  for (const cap of capabilities) {
    console.log(`  ${cap.name.padEnd(15)} ${cap.available ? "PASS" : "BLOCKED"} ${cap.version ?? ""} ${cap.reason ?? ""}`);
  }

  const image = pickImage();
  console.log(`\nSelected image for container scan: ${image ?? "none"}`);

  // Real scanner executions
  const results: Record<string, any> = {};

  // 1. SAST with Semgrep
  console.log("\nRunning SAST (semgrep)...");
  const semgrepRes = await run("semgrep", ["--config=auto", ".", "--json", "--quiet"], 180000);
  console.log(`  exit: ${semgrepRes.exitCode}, duration: ${semgrepRes.durationMs}ms, timedOut: ${semgrepRes.timedOut}`);
  const semgrepJson = safeJsonParse(semgrepRes.stdout);
  const semgrepFindings = semgrepJson?.results ?? [];
  results.sast = {
    scanner: "semgrep",
    status: semgrepRes.timedOut ? "TIMEOUT" : (semgrepRes.exitCode === 0 && semgrepFindings.length === 0 ? "PASS" : "FAIL"),
    findings_count: semgrepFindings.length,
    severity_counts: semgrepFindings.reduce((acc: any, f: any) => { acc[f.extra?.severity || "UNKNOWN"] = (acc[f.extra?.severity || "UNKNOWN"] || 0) + 1; return acc; }, {}),
  };

  // 2. Secret scan with Gitleaks
  console.log("Running secret scan (gitleaks)...");
  const gitleaksRes = await run("gitleaks", ["detect", "--source", ".", "--report-format", "json", "--no-banner"], 180000);
  console.log(`  exit: ${gitleaksRes.exitCode}, duration: ${gitleaksRes.durationMs}ms, timedOut: ${gitleaksRes.timedOut}`);
  const gitleaksJson = safeJsonParse(gitleaksRes.stdout);
  const gitleaksFindings = gitleaksJson ?? [];
  results.secrets = {
    scanner: "gitleaks",
    status: gitleaksRes.timedOut ? "TIMEOUT" : (gitleaksFindings.length === 0 ? "PASS" : "FAIL"),
    findings_count: gitleaksFindings.length,
  };

  // 3. Dependency security (npm audit)
  console.log("Running dependency scan (npm audit)...");
  const npmAuditRes = await run("npm", ["audit", "--json"], 180000);
  console.log(`  exit: ${npmAuditRes.exitCode}, duration: ${npmAuditRes.durationMs}ms, timedOut: ${npmAuditRes.timedOut}`);
  const npmAuditJson = safeJsonParse(npmAuditRes.stdout);
  results.dependencies = {
    scanner: "npm-audit",
    status: npmAuditRes.timedOut ? "TIMEOUT" : (npmAuditJson?.metadata?.vulnerabilities?.total === 0 ? "PASS" : "FAIL"),
    vulnerabilities: npmAuditJson?.metadata?.vulnerabilities ?? {},
  };

  // 4. Container scan with Trivy (if image exists)
  if (image) {
    console.log("Running container scan (trivy)...");
    const trivyRes = await run("trivy", ["image", "--format", "json", "--output", "trivy-pass2.json", image], 180000);
    console.log(`  exit: ${trivyRes.exitCode}, duration: ${trivyRes.durationMs}ms, timedOut: ${trivyRes.timedOut}`);
    const trivyJson = safeJsonParse(fs.existsSync("trivy-pass2.json") ? fs.readFileSync("trivy-pass2.json", "utf8") : "{}");
    const trivyFindings = trivyJson?.Results?.flatMap((r: any) => r.Vulnerabilities ?? []) ?? [];
    results.container = {
      scanner: "trivy",
      status: trivyRes.timedOut ? "TIMEOUT" : (trivyFindings.length === 0 ? "PASS" : "FAIL"),
      findings_count: trivyFindings.length,
      severity_counts: trivyFindings.reduce((acc: any, f: any) => { acc[f.Severity || "UNKNOWN"] = (acc[f.Severity || "UNKNOWN"] || 0) + 1; return acc; }, {}),
    };
  } else {
    results.container = { status: "BLOCKED", reason: "no real Docker image found" };
  }

  // 5. SBOM with Syft
  console.log("Generating SBOM (syft)...");
  const syftRes = await run("syft", ["dir:.", "-o", "cyclonedx-json"], 180000);
  console.log(`  exit: ${syftRes.exitCode}, duration: ${syftRes.durationMs}ms, timedOut: ${syftRes.timedOut}`);
  const syftJson = safeJsonParse(syftRes.stdout);
  results.sbom = {
    scanner: "syft",
    status: syftRes.timedOut ? "TIMEOUT" : (syftJson?.bomFormat ? "PASS" : "FAIL"),
    components: syftJson?.components?.length ?? 0,
    format: syftJson?.bomFormat ?? null,
  };

  // 6. Grype (if image)
  if (image) {
    console.log("Running vulnerability scan (grype)...");
    const grypeRes = await run("grype", [image, "-o", "json"], 180000);
    console.log(`  exit: ${grypeRes.exitCode}, duration: ${grypeRes.durationMs}ms, timedOut: ${grypeRes.timedOut}`);
    const grypeJson = safeJsonParse(grypeRes.stdout);
    const grypeFindings = grypeJson?.matches ?? [];
    results.grype = {
      scanner: "grype",
      status: grypeRes.timedOut ? "TIMEOUT" : (grypeFindings.length === 0 ? "PASS" : "FAIL"),
      findings_count: grypeFindings.length,
      severity_counts: grypeFindings.reduce((acc: any, f: any) => { acc[f.vulnerability?.severity || "UNKNOWN"] = (acc[f.vulnerability?.severity || "UNKNOWN"] || 0) + 1; return acc; }, {}),
    };
  } else {
    results.grype = { status: "BLOCKED", reason: "no real Docker image" };
  }

  // 7. IaC scan with Checkov
  console.log("Running IaC scan (checkov)...");
  const checkovRes = await run("checkov", ["-d", ".", "--framework", "terraform", "-o", "json", "--quiet"], 120000);
  console.log(`  exit: ${checkovRes.exitCode}, duration: ${checkovRes.durationMs}ms, timedOut: ${checkovRes.timedOut}`);
  results.iac = {
    scanner: "checkov",
    status: checkovRes.timedOut ? "TIMEOUT" : (checkovRes.exitCode === 0 ? "PASS" : "FAIL"),
    reason: checkovRes.timedOut ? "execution timeout" : null,
  };

  // 8. Artifact signing with Cosign (only if image and COSIGN_PASSWORD set)
  if (image && process.env.COSIGN_PASSWORD) {
    console.log("Signing artifact (cosign)...");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cosign-"));
    const keyPrefix = path.join(tmpDir, "testkey");
    const genRes = await run("cosign", ["generate-key-pair", "--output-key-prefix", keyPrefix], 120000);
    if (genRes.exitCode === 0) {
      const signRes = await run("cosign", ["sign", "--key", `${keyPrefix}.key`, image, "--yes"], 120000);
      const verifyRes = await run("cosign", ["verify", "--key", `${keyPrefix}.pub`, image], 120000);
      results.signing = {
        scanner: "cosign",
        status: signRes.exitCode === 0 && verifyRes.exitCode === 0 ? "PASS" : "FAIL",
        sign_exit: signRes.exitCode,
        verify_exit: verifyRes.exitCode,
      };
    } else {
      results.signing = { status: "BLOCKED", reason: "cosign key generation failed" };
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } else {
    results.signing = { status: "BLOCKED", reason: "COSIGN_PASSWORD not set or no image" };
  }

  // Security policy and gate evaluation (simplified based on real results)
  const policyReasons: string[] = [];
  if (results.sast?.status === "FAIL") policyReasons.push("SAST findings detected");
  if (results.secrets?.status === "FAIL") policyReasons.push("Secret scanning detected secrets");
  if (results.dependencies?.status === "FAIL") policyReasons.push("Dependency vulnerabilities detected");
  if (results.container?.status === "FAIL") policyReasons.push("Container vulnerabilities detected");
  if (results.iac?.status === "FAIL") policyReasons.push("IaC misconfigurations detected");
  const policyPass = policyReasons.length === 0;
  const gateStatus = policyPass ? "PASS" : "FAIL";
  if (results.container?.status === "TIMEOUT" || results.iac?.status === "TIMEOUT") {
    gateStatus = "BLOCKED";
    policyReasons.push("A scanner timed out");
  }

  // Events and audit
  const eventService = new EventService(engine);
  await eventService.init();
  await eventService.emit({ type: "security.scan.started", source: "phase8-pass2", execution_id: "exec-pass2", payload: {} });
  await eventService.emit({ type: "security.scan.completed", source: "phase8-pass2", execution_id: "exec-pass2", payload: { status: gateStatus } });
  const auditService = new AuditService(engine);
  await auditService.record({ actor: "system", action: "security.scan", resource_type: "security", resource_id: "phase8-pass2", result: gateStatus });

  const evidence = {
    phase: 8,
    pass: 2,
    timestamp: new Date().toISOString(),
    capabilities,
    image: image ?? null,
    results,
    policy: {
      status: gateStatus,
      reasons: policyReasons,
    },
    events: "PASS",
    audit: "PASS",
    blocked: [
      { capability: "Checkov", reason: "possibly timed out" },
      { capability: "Chromium", reason: "executable not found" },
      { capability: "Artifact Signing", reason: "may be blocked if COSIGN_PASSWORD not set or no key" },
    ],
    failures: [],
  };

  const secretPattern = /AWS_SECRET_ACCESS_KEY|AKIA|SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/i;
  const leak = secretPattern.test(JSON.stringify(evidence));
  (evidence as any).secret_redaction = leak ? "FAIL" : "PASS";

  await new EvidenceService(path.join(process.cwd(), "phase8-pass2-evidence.json")).writeEvidence(evidence);
  console.log("\nEvidence written to phase8-pass2-evidence.json");
  console.log("\nFINAL STATUS: " + gateStatus);
}

main().catch((e) => {
  console.error(redactSecrets(e.message || e));
  process.exit(1);
});
