import { NexusEngine } from "./db";
import { SecurityApi } from "./security-api";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export async function runSecurityTests(engine: NexusEngine) {
  const api = new SecurityApi(engine);
  const results: { name: string; status: "PASSED" | "FAILED"; error?: string }[] = [];

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, status: "PASSED" });
    } catch (e) {
      results.push({ name, status: "FAILED", error: (e as Error).message });
    }
  }

  await test("evidence persistence and retrieval", async () => {
    const execution = await api.startExecution("proj_test", "exec_test", "abc123");
    const evidence = await api.ingestEvidence({
      project_id: "proj_test",
      execution_id: "exec_test",
      commit_sha: "abc123",
      environment: "test",
      scanner: "sast",
      category: "SAST",
      status: "PASS",
      started_at: new Date().toISOString(),
    });
    const retrieved = await api.getEvidence("exec_test");
    assert(retrieved.length === 1, "evidence persisted");
    assert(retrieved[0].id === evidence.id, "id matches");
  });

  await test("finding lifecycle and transition enforcement", async () => {
    await api.startExecution("proj_test2", "exec_test2", "abc123");
    const evidence = await api.ingestEvidence({
      project_id: "proj_test2",
      execution_id: "exec_test2",
      commit_sha: "abc123",
      environment: "test",
      scanner: "sast",
      category: "SAST",
      status: "FAIL",
      started_at: new Date().toISOString(),
    });
    const findings = await api.ingestFindings(evidence, [
      { title: "Test vulnerability", severity: "HIGH", file: "src/test.ts", line: 1 },
    ]);
    assert(findings.length === 1, "finding created");
    const finding = findings[0];
    assert(finding.status === "NEW", "initial status NEW");

    let threw = false;
    try {
      await api.transitionFinding(finding.finding_id, "RESOLVED", "test");
    } catch (e) {
      threw = true;
    }
    assert(threw, "illegal transition rejected");

    await api.transitionFinding(finding.finding_id, "CONFIRMED", "test");
    const updated = await api.findingService.getById(finding.finding_id);
    assert(updated?.status === "CONFIRMED", "status changed to CONFIRMED");
  });

  await test("risk assessment and policy decision", async () => {
    const execution = await api.startExecution("proj_test3", "exec_test3", "abc123");
    const evidence = await api.ingestEvidence({
      project_id: "proj_test3",
      execution_id: "exec_test3",
      commit_sha: "abc123",
      environment: "test",
      scanner: "trivy",
      category: "CONTAINER",
      status: "FAIL",
      started_at: new Date().toISOString(),
    });
    await api.ingestFindings(evidence, [
      { title: "Critical CVE", severity: "CRITICAL", cve: "CVE-2024-0001" },
      { title: "High CVE", severity: "HIGH", cve: "CVE-2024-0002" },
    ]);
    const risk = await api.assessRisk("exec_test3");
    assert(risk.severity_counts.CRITICAL === 1, "critical count");
    const allEvidence = await api.getEvidence("exec_test3");
    const allFindings = await api.getFindings("exec_test3");
    const decision = await api.evaluatePolicy(execution, allEvidence, allFindings, risk);
    assert(decision.verdict === "FAIL", "policy blocks critical findings");
  });

  await test("false positive and accepted risk workflows", async () => {
    await api.startExecution("proj_test4", "exec_test4", "abc123");
    const evidence = await api.ingestEvidence({
      project_id: "proj_test4",
      execution_id: "exec_test4",
      commit_sha: "abc123",
      environment: "test",
      scanner: "sast",
      category: "SAST",
      status: "FAIL",
      started_at: new Date().toISOString(),
    });
    const findings = await api.ingestFindings(evidence, [
      { title: "False positive candidate", severity: "LOW", file: "a.ts", line: 1 },
    ]);
    const finding = findings[0];

    await api.transitionFinding(finding.finding_id, "FALSE_POSITIVE", "not a real issue", { false_positive_evidence: "manual review" });
    let updated = await api.findingService.getById(finding.finding_id);
    assert(updated?.status === "FALSE_POSITIVE" && updated.false_positive_reason === "not a real issue", "false positive recorded");

    await api.transitionFinding(finding.finding_id, "NEW", "re-evaluate");
    updated = await api.findingService.getById(finding.finding_id);
    assert(updated?.status === "NEW", "reverted to NEW");

    await api.transitionFinding(finding.finding_id, "ACCEPTED_RISK", "accepted for now", { approved_by: "owner@nexus.local", expires_at: new Date(Date.now() + 60000).toISOString() });
    updated = await api.findingService.getById(finding.finding_id);
    assert(updated?.status === "ACCEPTED_RISK" && updated.expires_at, "accepted risk recorded");

    updated!.expires_at = new Date(Date.now() - 1000).toISOString();
    await engine.put("security_findings", finding.finding_id, updated);
    await api.findingService.revertExpiredAcceptedRisks();
    updated = await api.findingService.getById(finding.finding_id);
    assert(updated?.status === "NEW", "expired accepted risk reverted to NEW");
  });

  return results;
}