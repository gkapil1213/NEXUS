// scripts/test-phase294-security-integrity.ts
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { SecurityApi } from "../src/core/security-api";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import type { SecurityExecution } from "../src/core/types";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }

async function main(): Promise<void> {
  section("Step 10.A — SecurityExecutionService.getByExecutionId");

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    await api.startExecution("proj-a", "exec-1", "commit-aaa", "sha256:aaa");
    const r = await api.getExecution("exec-1");
    ok(r !== undefined, "one match returns record");
    ok(r?.execution_id === "exec-1", "correct external execution_id");
    ok(r?.project_id === "proj-a", "correct project_id");
    ok(r?.id !== undefined && r.id !== "exec-1", "internal id differs from external");
  }

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    const r = await api.getExecution("exec-missing");
    ok(r === undefined, "no match returns undefined");
  }

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    await api.startExecution("proj-a", "exec-dup", "commit-1", "sha256:1");
    const dup: SecurityExecution = {
      id: "secexec_duplicate_forced",
      project_id: "proj-a",
      execution_id: "exec-dup",
      commit_sha: "commit-2",
      status: "QUEUED",
      started_at: new Date().toISOString(),
    };
    await engine.put("security_executions", dup.id, dup);
    let threw = false, code = "";
    try { await api.getExecution("exec-dup"); }
    catch (e: any) { threw = true; code = e?.code || ""; }
    ok(threw, "duplicate throws");
    ok(code === "AMBIGUOUS_EXECUTION_IDENTITY", "duplicate code is AMBIGUOUS_EXECUTION_IDENTITY");
  }

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    const created = await api.startExecution("proj-a", "exec-internal-test", "commit-aaa");
    const byInternal = await api.getExecution(created.id);
    ok(byInternal === undefined, "lookup by internal id returns undefined");
    const byExternal = await api.getExecution("exec-internal-test");
    ok(byExternal !== undefined, "lookup by external id succeeds");
  }

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    const malicious: SecurityExecution = {
      id: "secexec_mismatch_forced",
      project_id: "proj-a",
      execution_id: "exec-mismatch-actual",
      commit_sha: "commit-aaa",
      status: "QUEUED",
      started_at: new Date().toISOString(),
    };
    await engine.put("security_executions", malicious.id, malicious);
    const originalByIndex = engine.byIndex.bind(engine);
    engine.byIndex = async (store: string, index: string, key: string) => {
      if (store === "security_executions" && index === "byExecution" && key === "exec-requested") {
        return [malicious];
      }
      return originalByIndex(store, index, key);
    };
    let threw = false, code = "";
    try { await api.getExecution("exec-requested"); }
    catch (e: any) { threw = true; code = e?.code || ""; }
    ok(threw, "mismatched execution_id under index throws");
    ok(code === "EXECUTION_ID_MISMATCH", "mismatched code is EXECUTION_ID_MISMATCH");
  }

  section("Step 10.B — SecurityReleaseGate fail-closed");

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    const gate = new SecurityReleaseGate(api);
    const decision = await gate.evaluate({
      release_id: "rel-x",
      execution_id: "exec-does-not-exist",
      artifact_id: "art-x",
      artifact_digest: "sha256:xxx",
    });
    ok(decision.canonical_status === "BLOCK", "gate blocks when execution missing");
    ok(decision.checks.POLICY?.status === "BLOCKED", "gate POLICY status BLOCKED when missing");
  }

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    const gate = new SecurityReleaseGate(api);
    await api.startExecution("proj-a", "exec-ambig", "commit-aaa");
    const dup: SecurityExecution = {
      id: "secexec_duplicate_forced2",
      project_id: "proj-a",
      execution_id: "exec-ambig",
      commit_sha: "commit-bbb",
      status: "QUEUED",
      started_at: new Date().toISOString(),
    };
    await engine.put("security_executions", dup.id, dup);
    const decision = await gate.evaluate({
      release_id: "rel-x",
      execution_id: "exec-ambig",
      artifact_id: "art-x",
      artifact_digest: "sha256:xxx",
    });
    ok(decision.canonical_status === "BLOCK", "gate blocks when execution duplicate");
    ok((decision.checks.POLICY?.reason || "").includes("Execution lookup failed"), "gate reason mentions lookup failed");
  }

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    engine.byIndex = async () => { throw new Error("simulated persistence error"); };
    const gate = new SecurityReleaseGate(api);
    const decision = await gate.evaluate({
      release_id: "rel-x",
      execution_id: "exec-any",
      artifact_id: "art-x",
      artifact_digest: "sha256:xxx",
    });
    ok(decision.canonical_status === "BLOCK", "gate blocks when lookup throws");
    ok(decision.status !== "PASS", "gate status not PASS when lookup throws");
  }

  {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);
    const gate = new SecurityReleaseGate(api);
    const supplied: any = {
      id: "secexec_supplied_fake",
      project_id: "proj-a",
      execution_id: "exec-other",
      commit_sha: "commit-aaa",
      status: "RUNNING",
      started_at: new Date().toISOString(),
    };
    const decision = await gate.evaluate({
      release_id: "rel-x",
      execution_id: "exec-requested",
      artifact_id: "art-x",
      artifact_digest: "sha256:xxx",
      execution: supplied,
    });
    ok(decision.canonical_status === "BLOCK", "gate blocks when supplied execution mismatched");
    const reason = decision.checks.POLICY?.reason || "";
    ok(reason.includes("mismatch") || reason.includes("Caller-supplied"), "gate reason identifies caller-supplied mismatch");
  }

  section("Step 10.C — SecurityReleaseGate policy decision mapping");

  const policyCases: Array<{
    name: string;
    decision?: any;
    expectedCanonical: string;
    expectedStatus: string;
    expectedReason?: string;
    shouldThrow?: boolean;
  }> = [
    {
      name: "canonical ALLOW maps to POLICY PASS",
      decision: { canonical_decision: "ALLOW", reasons: [] },
      expectedCanonical: "ALLOW",
      expectedStatus: "PASS",
    },
    {
      name: "canonical BLOCK maps to POLICY FAIL",
      decision: { canonical_decision: "BLOCK", reasons: ["blocked by policy"] },
      expectedCanonical: "BLOCK",
      expectedStatus: "FAIL",
    },
    {
      name: "canonical REQUIRE_REVIEW maps to POLICY BLOCKED",
      decision: { canonical_decision: "REQUIRE_REVIEW", reasons: ["review required"] },
      expectedCanonical: "REQUIRE_REVIEW",
      expectedStatus: "BLOCKED",
    },
    {
      name: "invalid canonical decision fails closed",
      decision: { canonical_decision: "ALLOW_WITH_WARNINGS", verdict: "PASS" },
      expectedCanonical: "BLOCK",
      expectedStatus: "FAIL",
      expectedReason: "Invalid canonical security decision",
    },
    {
      name: "legacy PASS maps to POLICY ALLOW",
      decision: { verdict: "PASS", reasons: [] },
      expectedCanonical: "ALLOW",
      expectedStatus: "PASS",
    },
    {
      name: "legacy FAIL maps to POLICY BLOCK",
      decision: { verdict: "FAIL", reasons: ["legacy failure"] },
      expectedCanonical: "BLOCK",
      expectedStatus: "FAIL",
    },
    {
      name: "legacy BLOCKED maps to POLICY BLOCK",
      decision: { verdict: "BLOCKED", reasons: ["legacy blocked"] },
      expectedCanonical: "BLOCK",
      expectedStatus: "FAIL",
    },
    {
      name: "unknown legacy verdict fails closed",
      decision: { verdict: "UNKNOWN" },
      expectedCanonical: "BLOCK",
      expectedStatus: "FAIL",
      expectedReason: "Unknown or missing legacy security verdict",
    },
    {
      name: "missing legacy verdict fails closed",
      decision: {},
      expectedCanonical: "BLOCK",
      expectedStatus: "FAIL",
      expectedReason: "Unknown or missing legacy security verdict",
    },
    {
      name: "policy evaluation exception fails closed",
      expectedCanonical: "BLOCK",
      expectedStatus: "BLOCKED",
      expectedReason: "Policy evaluation failed",
      shouldThrow: true,
    },
  ];

  for (const testCase of policyCases) {
    const engine = await SQLiteEngine.open(":memory:");
    const api = new SecurityApi(engine);

    await api.startExecution(
      "proj-policy",
      "exec-policy-" + passed + "-" + failed,
      "commit-policy",
      "sha256:policy",
    );

    (api as any).evaluatePolicy = async () => {
      if (testCase.shouldThrow) {
        throw new Error("Controlled policy evaluation failure");
      }
      return testCase.decision;
    };

    const gate = new SecurityReleaseGate(api);
    const executionId = "exec-policy-" + passed + "-" + failed;

    const result = await gate.evaluate({
      release_id: "rel-policy",
      execution_id: executionId,
      artifact_id: "art-policy",
      artifact_digest: "sha256:policy",
    });

    const policyCheck = result.checks.POLICY;

    ok(
      policyCheck?.canonical_status === testCase.expectedCanonical &&
        policyCheck?.status === testCase.expectedStatus,
      testCase.name,
    );

    if (testCase.expectedReason) {
      ok(
        (policyCheck?.reason || "").includes(testCase.expectedReason),
        testCase.name + " — expected fail-closed reason",
      );
    }
  }
  console.log("\n============================================");
  console.log("Step 10 — PASS: " + passed + "  FAIL: " + failed + "  BLOCKED: " + blocked + "  NOT EXECUTED: " + notExec);
  console.log("============================================");
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });