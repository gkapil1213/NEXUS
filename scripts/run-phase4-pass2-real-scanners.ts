import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";
import spawn from "cross-spawn";
import { writeFileSync } from "fs";

// ---------- real capability detection ----------
function runDetect(command: string, args: string[], timeoutMs = 20000): Promise<{ available: boolean; version?: string; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err: any) => {
      clearTimeout(timer);
      resolve({ available: false, reason: err?.code === "ENOENT" ? "executable not found" : err?.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ available: false, reason: "timeout" });
      } else if (code === 0) {
        resolve({ available: true, version: stdout.trim().split("\n")[0] });
      } else {
        resolve({ available: false, reason: stderr.trim() || `exit code ${code}` });
      }
    });
  });
}

async function detectCapabilities() {
  const tools: Record<string, { cmd: string; args: string[] }> = {
    node: { cmd: "node", args: ["--version"] },
    npm: { cmd: "npm", args: ["--version"] },
    semgrep: { cmd: "semgrep", args: ["--version"] },
    gitleaks: { cmd: "gitleaks", args: ["version"] },
    trivy: { cmd: "trivy", args: ["--version"] },
    checkov: { cmd: "checkov", args: ["--version"] },
    syft: { cmd: "syft", args: ["version"] },
    grype: { cmd: "grype", args: ["version"] },
    playwright: { cmd: "npx", args: ["playwright", "--version"] },
    chromium: { cmd: "chromium", args: ["--version"] },
    docker: { cmd: "docker", args: ["--version"] },
    docker_daemon: { cmd: "docker", args: ["info", "--format", "{{.ServerVersion}}"] },
  };

  const result: Record<string, { available: boolean; version?: string; reason?: string }> = {};
  for (const [name, cfg] of Object.entries(tools)) {
    result[name] = await runDetect(cfg.cmd, cfg.args);
  }
  return result;
}

// ---------- main verification ----------
async function main() {
  const engine = await openEngine();
  const api = new SecurityApi(engine);
  const runner = new SecurityScannerRunner(engine, api);

  console.log("========================================");
  console.log("NEXUS PHASE 4 — PASS 2");
  console.log("REAL SECURITY SCANNER EXECUTION");
  console.log("========================================\n");

  // 1. Capabilities
  const capabilities = await detectCapabilities();
  console.log("CAPABILITIES\n");
  for (const [name, cap] of Object.entries(capabilities)) {
    const status = cap.available ? "PASS" : "BLOCKED";
    const version = cap.version ? ` (${cap.version})` : "";
    const reason = cap.reason ? ` — ${cap.reason}` : "";
    console.log(`${name.padEnd(15)} ${status}${version}${reason}`);
  }
  console.log("");

  // 2. Start execution with unique IDs
  const now = Date.now();
  const projectId = "proj_phase4_pass2";
  const executionId = `exec_pass2_${now}`;
  const releaseId = `rel_pass2_${now}`;
  const commitSha = "deadbeef";
  const artifactDigest = `sha256:pass2-${now}`;

  const execution = await api.startExecution(projectId, executionId, commitSha, artifactDigest, releaseId);
  console.log(`Security execution started: ${execution.id}\n`);

  // 3. Run all scanners
  const summary = await runner.runAll(executionId, projectId, commitSha, artifactDigest, releaseId);

  console.log("SCANNERS\n");
  const scannerStatuses: Record<string, string> = {};
  for (const r of summary.results) {
    scannerStatuses[r.scanner] = r.status;
    console.log(
      `  ${r.scanner.padEnd(15)} ${r.status.padEnd(8)} findings=${r.findings_count} time=${r.duration_ms}ms${
        r.blocked_reason ? ` blocked_reason=${r.blocked_reason}` : ""
      }`
    );
  }
  console.log("");

  // 4. Risk
  const risk = await api.assessRisk(executionId);
  console.log("RISK\n");
  console.log(`Critical: ${risk.severity_counts.CRITICAL}`);
  console.log(`High:     ${risk.severity_counts.HIGH}`);
  console.log(`Medium:   ${risk.severity_counts.MEDIUM}`);
  console.log(`Low:      ${risk.severity_counts.LOW}`);
  console.log(`Unknown:  ${risk.severity_counts.UNKNOWN}`);
  console.log(`Risk Score: ${risk.risk_score}\n`);

  // 5. Policy
  const evidenceList = await api.getEvidence(executionId);
  const allFindings = await api.getFindings(executionId);
  const decision = await api.evaluatePolicy(execution, evidenceList, allFindings, risk);
  console.log("POLICY\n");
  console.log(`${decision.verdict}\n`);

  // 6. Release decision
  const releaseDecision = decision.verdict === "PASS" ? "RELEASE" : decision.verdict === "FAIL" ? "REJECTED" : "BLOCKED";
  console.log("RELEASE DECISION\n");
  console.log(`${releaseDecision}\n`);

  // 7. Evidence summary
  console.log("EVIDENCE\n");
  const evidenceCount = evidenceList.length;
  const findingCount = allFindings.length;
  console.log(`Execution: ${executionId}`);
  console.log(`Artifacts: ${evidenceCount}`);
  console.log(`Findings: ${findingCount}`);
  const allEvents = await engine.all<any>("events");
  const allAudit = await engine.all<any>("audit");
  console.log(`Events: ${allEvents.length}`);
  console.log(`Audit records: ${allAudit.length}`);
  console.log("");

  // 8. Persist evidence file
  const evidenceFile = {
    timestamp: new Date().toISOString(),
    project_id: projectId,
    execution_id: executionId,
    commit_sha: commitSha,
    artifact_digest: artifactDigest,
    release_id: releaseId,
    capabilities,
    scanners: summary.results.map((r) => ({
      scanner: r.scanner,
      category: r.category,
      status: r.status,
      duration_ms: r.duration_ms,
      evidence_id: r.evidence_id,
      findings_count: r.findings_count,
      blocked_reason: r.blocked_reason,
    })),
    risk: {
      severity_counts: risk.severity_counts,
      risk_score: risk.risk_score,
    },
    policy_decision: decision,
    release_decision: releaseDecision,
    findings_count: findingCount,
    evidence_count: evidenceCount,
  };
  writeFileSync("phase4-pass2-evidence.json", JSON.stringify(evidenceFile, null, 2));
  console.log("Evidence written to phase4-pass2-evidence.json");

  console.log("\n========================================");
  console.log("FINAL STATUS");
  console.log("========================================");
  console.log(releaseDecision === "RELEASE" ? "PASS" : releaseDecision === "BLOCKED" ? "BLOCKED" : "FAIL");
}

main().catch((err) => {
  console.error("Pass 2 verification failed:", err);
  process.exit(1);
});
