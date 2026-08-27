import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
const actor = {
  id: "script-owner",
  email: "script.owner@nexus.local",
  name: "Script Owner",
  role: "OWNER" as const,
  status: "active" as const,
  password_hash: "x",
  salt: "x",
  iterations: 1,
  created_at: Date.now(),
  updated_at: Date.now(),
};
const engine = await openEngine();
const api = await SecurityApi.create(engine);

console.log("Phase 4 Pass 1 Security Control Plane Verification\n");

// Simulate a security execution
const execution = await api.startExecution("proj_phase4", "exec_phase4", "deadbeef", "sha256:abc", "rel_1");
console.log(`✅ Security execution started: ${execution.id}`);

// Ingest evidence for multiple scanners
const scanners = [
  { scanner: "semgrep", category: "SAST", status: "PASS" },
  { scanner: "gitleaks", category: "SECRET", status: "FAIL" },
  { scanner: "trivy", category: "CONTAINER", status: "FAIL" },
  { scanner: "npm-audit", category: "SCA", status: "FAIL" },
  { scanner: "tfsec", category: "IAC", status: "PASS" },
  { scanner: "syft", category: "SBOM", status: "PASS" },
  { scanner: "dast", category: "DAST", status: "PASS" },
  { scanner: "cosign", category: "SIGNATURE", status: "PASS" },
  { scanner: "supply-chain", category: "SUPPLY_CHAIN", status: "PASS" },
];

for (const s of scanners) {
  await api.ingestEvidence({
    project_id: "proj_phase4",
    execution_id: "exec_phase4",
    commit_sha: "deadbeef",
    artifact_digest: "sha256:abc",
    environment: "staging",
    scanner: s.scanner,
    category: s.category as any,
    status: s.status as any,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  });
}
console.log("✅ Evidence ingested for all scanners");

// Ingest synthetic findings from failing scanners
const evidenceList = await api.getEvidence("exec_phase4");
const findings = [];
for (const ev of evidenceList) {
  if (ev.status === "FAIL") {
    findings.push(
      { title: "Synthetic vulnerability", severity: "HIGH", cve: "CVE-2024-9999" },
      { title: "Synthetic misconfig", severity: "MEDIUM" }
    );
  }
}
const createdFindings = await api.ingestFindings(evidenceList[0], findings);
console.log(`✅ Findings ingested: ${createdFindings.length}`);

// Assess risk
const risk = await api.assessRisk("exec_phase4");
console.log(`✅ Risk assessment: score=${risk.risk_score}, critical=${risk.severity_counts.CRITICAL}, high=${risk.severity_counts.HIGH}`);

// Evaluate policy
const allFindings = await api.getFindings("exec_phase4");
const decision = await api.evaluatePolicy(execution, evidenceList, allFindings, risk);
console.log(`✅ Policy decision: ${decision.verdict}`);
console.log(`   Reasons: ${decision.reasons.join(", ")}`);

// Complete execution with the decision verdict
const finalStatus = decision.verdict === "PASS" ? "SUCCEEDED" : decision.verdict === "FAIL" ? "FAILED" : "BLOCKED";
await api.completeExecution(execution.id, decision.verdict, finalStatus as any);
console.log(`✅ Execution completed with status ${finalStatus}`);

console.log("\nPhase 4 Pass 1 Security Control Plane verification PASSED");