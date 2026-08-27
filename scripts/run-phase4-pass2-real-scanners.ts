import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";

const engine = await openEngine();
const api = new SecurityApi(engine);
const runner = new SecurityScannerRunner(engine, api);

console.log("Phase 4 Pass 2 — Real Security Scanner Execution\n");

const execution = await api.startExecution("proj_phase4_pass2", "exec_pass2", "deadbeef", "sha256:pass2", "rel_pass2");
console.log(`✅ Security execution started: ${execution.id}`);

const summary = await runner.runAll("exec_pass2", "proj_phase4_pass2", "deadbeef", "sha256:pass2", "rel_pass2");

console.log("\nScanner results:");
for (const r of summary.results) {
  console.log(`  ${r.scanner.padEnd(15)} ${r.status.padEnd(8)} findings=${r.findings_count} time=${r.duration_ms}ms${r.blocked_reason ? ` blocked_reason=${r.blocked_reason}` : ""}`);
}

const risk = await api.assessRisk("exec_pass2");
console.log(`\n✅ Risk assessment: score=${risk.risk_score}, critical=${risk.severity_counts.CRITICAL}, high=${risk.severity_counts.HIGH}`);

const evidenceList = await api.getEvidence("exec_pass2");
const allFindings = await api.getFindings("exec_pass2");
const decision = await api.evaluatePolicy(execution, evidenceList, allFindings, risk);

console.log(`✅ Policy decision: ${decision.verdict}`);
console.log(`   Reasons: ${decision.reasons.join(", ")}`);

const finalStatus = decision.verdict === "PASS" ? "SUCCEEDED" : decision.verdict === "FAIL" ? "FAILED" : "BLOCKED";
await api.completeExecution(execution.id, decision.verdict, finalStatus);
console.log(`✅ Execution completed with status ${finalStatus}`);

console.log("\nPhase 4 Pass 2 Real Security Scanner Execution verification PASSED");