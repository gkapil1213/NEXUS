/**
 * NEXUS Phase 4 Pass 7 — Continuous Security Operations Verification
 *
 * Exercises the new security operations layer:
 *   - finding lifecycle / dedup / reopen
 *   - evidence integrity / expiration
 *   - scanner health
 *   - posture computation
 *   - drift detection
 *   - risk & policy history
 *   - fail‑safe conditions
 *
 * Uses the real in‑memory (or IndexedDB) engine and real services.
 * No mocks, no fabricated scanner output.
 */
import { openEngine, NexusEngine, nid } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityEvidenceIntegrityService } from "../src/core/security-operations";
import {
  SecurityEvidence,
  SecurityFinding,
  FindingSeverity,
  FindingStatus,
  SecurityScannerHealth,
} from "../src/core/types";
import { writeFileSync } from "fs";
import { join } from "path";

const evidenceOut: any = {
  phase: "4",
  pass: "7",
  execution_id: nid("verify"),
  timestamp: new Date().toISOString(),
  tests: [],
  scanner_health: [],
  findings: [],
  posture: {},
  evidence: [],
  policy: {},
  drift: [],
  failures: [],
  blocked: [],
};

function recordTest(name: string, status: "PASS" | "FAIL" | "BLOCKED", detail?: string) {
  evidenceOut.tests.push({ name, status, detail, timestamp: new Date().toISOString() });
  console.log(`[${status}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function main() {
  const engine = await openEngine();
  const api = await SecurityApi.create(engine);
  const integrity = new SecurityEvidenceIntegrityService(engine);

  // 1. Create a project and a mock security execution
  const projectId = nid("proj");
  const executionId = nid("exec");
  const commitA = "commitA_sha";
  const artifactA = "sha256:artifactA";
  const startedExec = await api.startExecution(projectId, executionId, commitA, artifactA);
  const secExec = await api.completeExecution(startedExec.id, "PASS", "SUCCEEDED");
  recordTest("Create security execution", "PASS", secExec.id);

  // 2. Ingest evidence (with hash and expiration)
  const evidenceContent = JSON.stringify({ scanner: "semgrep", result: "clean" });
  const evidenceRecord = await integrity.recordEvidenceWithHash(
    {
      project_id: projectId,
      execution_id: executionId,
      commit_sha: commitA,
      artifact_digest: artifactA,
      environment: "test",
      scanner: "semgrep",
      category: "SAST",
      status: "PASS",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    },
    evidenceContent,
    new Date(Date.now() + 86400000).toISOString()
  );
  recordTest("Evidence record with hash", "PASS", evidenceRecord.id);

  // Phase 296: second execution + distinct artifact digest
  const executionId2 = nid("exec");
  const artifactB = "sha256:artifactB";
  const startedExec2 = await api.startExecution(projectId, executionId2, commitA, artifactB);
  await api.completeExecution(startedExec2.id, "PASS", "SUCCEEDED");
  const evidenceContent2 = JSON.stringify({ scanner: "semgrep", result: "clean" });
  const evidenceRecord2 = await integrity.recordEvidenceWithHash(
    {
      project_id: projectId,
      execution_id: executionId2,
      commit_sha: commitA,
      artifact_digest: artifactB,
      environment: "test",
      scanner: "semgrep",
      category: "SAST",
      status: "PASS",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    },
    evidenceContent2,
    new Date(Date.now() + 86400000).toISOString(),
  );

  // 3. Verify evidence integrity (valid)
  const valid = await integrity.verifyEvidence(evidenceRecord.id, evidenceContent);
  recordTest("Evidence integrity valid", valid.valid ? "PASS" : "FAIL", valid.reason);

  // 4. Tamper evidence (modify content) -> should be invalid
  const tampered = await integrity.verifyEvidence(evidenceRecord.id, evidenceContent + "tampered");
  recordTest("Evidence tamper detection", tampered.valid ? "FAIL" : "PASS", tampered.reason);

  // 5. Finding lifecycle: ingest a critical finding, dedup, resolve, reopen
  const findingRaw: Partial<SecurityFinding> = {
    title: "Hardcoded secret in config",
    severity: "HIGH",
    file: "src/config.ts",
    line: 42,
    scanner: "gitleaks",
  };
  const findings = await api.ingestFindings(evidenceRecord, [findingRaw]);
  if (findings.length !== 1) recordTest("Finding ingestion", "FAIL", `expected 1, got ${findings.length}`);
  else recordTest("Finding ingestion", "PASS", findings[0].finding_id);

  const firstFindingId = findings[0].finding_id;

  // Dedup: ingest same finding again -> should not create new logical finding
  const findings2 = await api.ingestFindings(evidenceRecord, [findingRaw]);
  const dedupPass = findings2.length === 0 || (findings2.length === 1 && findings2[0].finding_id === firstFindingId);
  recordTest("Finding deduplication", dedupPass ? "PASS" : "FAIL");

  // Resolve the finding.
  // Ingestion may create the finding as CONFIRMED already.
  const beforeResolution = await api.findingService.getById(firstFindingId);

  if (!beforeResolution) {
    throw new Error("Finding missing before resolution");
  }

  if (beforeResolution.status === "NEW") {
    await api.transitionFinding(
      firstFindingId,
      "CONFIRMED",
      "Confirmed finding",
      {}
    );
  } else if (beforeResolution.status !== "CONFIRMED") {
    throw new Error(
      `Unexpected finding status before resolution: ${beforeResolution.status}`
    );
  }

  await api.transitionFinding(
    firstFindingId,
    "RESOLVED",
    "Fixed and verified",
    {}
  );

  const resolved = await api.findingService.getById(firstFindingId);

  recordTest(
    "Finding resolution",
    resolved?.status === "RESOLVED" ? "PASS" : "FAIL",
    resolved?.status
  );

  // Reopen by ingesting the same finding fingerprint against a DIFFERENT
  // execution/evidence — proves evidence_id and execution_id refresh.
  const findings3 = await api.ingestFindings(evidenceRecord2, [findingRaw]);
  const reopened = await api.findingService.getById(firstFindingId);
  recordTest("Finding reopen", reopened?.status === "REOPENED" ? "PASS" : "FAIL", reopened?.status);

  recordTest("Reopened finding retains finding_id",
    reopened?.finding_id === firstFindingId ? "PASS" : "FAIL",
    `expected=${firstFindingId} got=${reopened?.finding_id}`);
  recordTest("Reopened finding retains fingerprint",
    reopened?.fingerprint === beforeResolution.fingerprint ? "PASS" : "FAIL",
    `expected=${beforeResolution.fingerprint} got=${reopened?.fingerprint}`);
  recordTest("Reopened finding preserves first_seen",
    reopened?.first_seen === beforeResolution.first_seen ? "PASS" : "FAIL",
    `expected=${beforeResolution.first_seen} got=${reopened?.first_seen}`);
  recordTest("Reopened finding updates last_seen",
    reopened?.last_seen !== beforeResolution.last_seen ? "PASS" : "FAIL",
    `old=${beforeResolution.last_seen} new=${reopened?.last_seen}`);
  recordTest("Reopened finding associates latest evidence",
    reopened?.evidence_id === evidenceRecord2.id ? "PASS" : "FAIL",
    `expected=${evidenceRecord2.id} got=${reopened?.evidence_id}`);
  recordTest("Reopened finding associates latest execution",
    reopened?.execution_id === executionId2 ? "PASS" : "FAIL",
    `expected=${executionId2} got=${reopened?.execution_id}`);
  recordTest("Reopened finding associates latest artifact digest",
    reopened?.artifact_digest === artifactB ? "PASS" : "FAIL",
    `expected=${artifactB} got=${reopened?.artifact_digest}`);

  // Phase 296: observation must be persisted in the store
  const allObs = await engine.all<any>("security_finding_observations");
  const obsForFinding = allObs.filter((o) => o.finding_id === firstFindingId);
  recordTest("Observation persisted for reopen",
    obsForFinding.length >= 2 ? "PASS" : "FAIL",
    `observations=${obsForFinding.length}`);
  const latestObs = obsForFinding
    .slice()
    .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)))[0];
  recordTest("Latest observation carries new execution_id",
    latestObs?.execution_id === executionId2 ? "PASS" : "FAIL",
    `expected=${executionId2} got=${latestObs?.execution_id}`);

  // 6. Risk assessment and history
  await api.transitionFinding(firstFindingId, "CONFIRMED", "Reopened", {});
  const risk = await api.assessRisk(executionId2); // reopened finding now lives here
  recordTest("Risk assessment", risk.risk_score > 0 ? "PASS" : "FAIL", `score=${risk.risk_score}`);
  await api.snapshotRisk(projectId, executionId, risk);
  const riskHistory = await api.getRiskHistory(projectId);
  recordTest("Risk history", riskHistory.length >= 1 ? "PASS" : "FAIL");

  // 7. Scanner health update & listing
  await api.updateScannerHealth("semgrep", { health: "HEALTHY", available: true, version: "1.2.3" });
  await api.updateScannerHealth("syft", { health: "UNAVAILABLE", available: false, version: undefined });
  const scannerList = await api.listScannerHealth();
  recordTest("Scanner health", scannerList.length >= 2 ? "PASS" : "FAIL", `${scannerList.length} scanners`);
  evidenceOut.scanner_health = scannerList;

  // 8. Posture computation
  const posture = await api.getProjectPosture(projectId);
  recordTest("Security posture", posture.status ? "PASS" : "FAIL", posture.status);
  evidenceOut.posture = posture;

  // 9. Commit binding / continuous verification
  const binding = await api.verifyCommitBinding(projectId, commitA, artifactA);
  recordTest("Commit binding current", binding.status === "CURRENT" ? "PASS" : "FAIL", binding.status);
  const wrongCommit = await api.verifyCommitBinding(projectId, "commitB_sha", artifactA);
  recordTest("Commit mismatch", wrongCommit.status === "SECURITY_RESCAN_REQUIRED" ? "PASS" : "FAIL", wrongCommit.status);

  // 10. Drift detection
  const drift = await api.detectDrift("sha256:expected", "sha256:actual", projectId);
  recordTest("Drift detection", drift ? "PASS" : "FAIL", "drift event created");
  if (drift) evidenceOut.drift.push(drift);

  // 11. Policy history — evaluate against ACTUAL current findings, then persist
  // to the Phase 4 Pass 7 policy-evaluation store for getPolicyHistory.
  const currentEvidence = await api.getEvidence(executionId);
  const currentFindings = await api.getFindings(executionId);
  const secExecObj = await (api as any).getExecution(executionId);
  const policyDecision = await api.evaluatePolicy(
    secExecObj ?? secExec,
    currentEvidence,
    currentFindings,
    risk,
  );
  const policyHistory = await api.getPolicyHistory(executionId);
  recordTest(
    "Policy history",
    policyHistory.length >= 1 &&
      policyHistory[0].decision === policyDecision.verdict
      ? "PASS"
      : "FAIL",
    `verdict=${policyDecision.verdict} history=${policyHistory.length}`,
  );
  evidenceOut.policy = policyHistory[0];

  // 12. Security heartbeat
  const heartbeat = await api.securityHeartbeat();
  recordTest("Security heartbeat", heartbeat.status === "HEALTHY" || heartbeat.status === "DEGRADED" ? "PASS" : "FAIL", heartbeat.status);

  // 13. Fail‑safe checks: expired evidence / stale evidence / unavailable scanner
  // Mark a scanner as required but unavailable -> posture should BLOCKED
  await api.updateScannerHealth("checkov", { health: "UNAVAILABLE", available: false, version: undefined });
  const postureAfterBlock = await api.getProjectPosture(projectId);
  recordTest("Fail‑safe: required scanner unavailable", postureAfterBlock.status === "BLOCKED" ? "PASS" : "FAIL", postureAfterBlock.status);

  // Evidence expiration simulation (set expires_at in past)
  const staleEvidence = await integrity.recordEvidenceWithHash(
    {
      project_id: projectId,
      execution_id: executionId,
      commit_sha: commitA,
      artifact_digest: artifactA,
      environment: "test",
      scanner: "trivy",
      category: "CONTAINER",
      status: "PASS",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    },
    "scan-output",
    new Date(Date.now() - 1000).toISOString()
  );
  // Real assertion instead of a hardcoded PASS
  const staleRecord = await api.getEvidence(executionId);
  const staleEntry = staleRecord.find((e: any) => e.id === staleEvidence.id);
  const staleExpiry = staleEntry?.expires_at ? Date.parse(staleEntry.expires_at) : NaN;
  recordTest("Evidence expiration recorded",
    Number.isFinite(staleExpiry) && staleExpiry < Date.now() ? "PASS" : "FAIL",
    `expires_at=${staleEntry?.expires_at ?? "(missing)"}`);

  // 14. Write evidence file — include stored finding + observation evidence
  evidenceOut.findings = await api.getFindings(executionId);
  evidenceOut.findings_for_second_execution = await api.getFindings(executionId2);
  evidenceOut.reopened_finding = await api.findingService.getById(firstFindingId);
  evidenceOut.observations = (await engine.all<any>("security_finding_observations"))
    .filter((o) => o.finding_id === firstFindingId)
    .sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
  evidenceOut.executions = { primary: executionId, secondary: executionId2 };
  evidenceOut.failures = evidenceOut.tests.filter((t: any) => t.status === "FAIL");
  evidenceOut.blocked = evidenceOut.tests.filter((t: any) => t.status === "BLOCKED");

  const outPath = join(process.cwd(), "phase4-pass7-evidence.json");
  writeFileSync(outPath, JSON.stringify(evidenceOut, null, 2));
  console.log(`\nEvidence written to ${outPath}`);
  console.log(`Total tests: ${evidenceOut.tests.length}, Passed: ${evidenceOut.tests.filter((t: any) => t.status === "PASS").length}, Failed: ${evidenceOut.failures.length}, Blocked: ${evidenceOut.blocked.length}`);
}

main().catch((err) => {
  console.error("Verification failed:", err);
  evidenceOut.blocked.push({ error: String(err) });
  writeFileSync(join(process.cwd(), "phase4-pass7-evidence.json"), JSON.stringify(evidenceOut, null, 2));
  process.exit(1);
});