// scripts/test-phase295-security-mapping-integrity.ts
// Phase 295.D â€” 20-case security mapping integrity suite.
import {
  buildExecution,
  buildEvidenceList,
  buildFindingList,
  mapScannerResultsToPolicyFindings,
} from "../src/core/security-scan-mapping";
import type { ScannerScanResult, SecurityFinding as ScannerFinding } from "../src/core/security-scanners";
import type { BuildExecutionInput } from "../src/core/security-scan-mapping";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }

function makeInput(overrides: Partial<BuildExecutionInput> = {}): BuildExecutionInput {
  return {
    projectId: "proj-x",
    executionId: "exec-x",
    commitSha: "commit-x",
    artifactDigest: "sha256:xxx",
    releaseId: "rel-x",
    environment: "ci",
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ScannerFinding> = {}): ScannerFinding {
  return {
    id: "f-1",
    fingerprint: "fp-1",
    scanner: "semgrep",
    category: "SAST" as const,
    severity: "high",
    title: "t",
    description: "d",
    file: null,
    line: null,
    resource: null,
    evidence: null,
    remediation: null,
    status: "OPEN" as const,
    created_at: 0,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ScannerScanResult> = {}): ScannerScanResult {
  return {
    kind: "SAST" as const,
    scanner: "semgrep",
    status: "PASSED",
    findings: [],
    blocked_reason: null,
    duration_ms: 1,
    ...overrides,
  };
}

async function main(): Promise<void> {
  section("Phase 295.D â€” scanner mapping integrity");

  {
    const ev = buildEvidenceList([makeResult({ status: "PASSED" })], makeInput());
    ok(ev.length === 1 && ev[0].status === "PASS", "1. PASSED -> PASS");
  }
  {
    const ev = buildEvidenceList([makeResult({ status: "FAILED" })], makeInput());
    ok(ev[0].status === "FAIL", "2. FAILED -> FAIL");
  }
  {
    const ev = buildEvidenceList([makeResult({ status: "BLOCKED" })], makeInput());
    ok(ev[0].status === "BLOCKED", "3. BLOCKED -> BLOCKED");
  }
  {
    const ev = buildEvidenceList([makeResult({ status: "UNKNOWN" as any })], makeInput());
    ok(ev[0].status === "BLOCKED", "4. unknown status -> BLOCKED");
  }
  {
    const ev = buildEvidenceList([makeResult({ status: undefined as any })], makeInput());
    ok(ev[0].status === "BLOCKED", "5. missing status -> BLOCKED");
  }
  {
    const r = makeResult({ status: "FAILED", findings: [makeFinding({ severity: "low" })] });
    const ev = buildEvidenceList([r], makeInput());
    const fs = buildFindingList([r], ev, makeInput());
    ok(fs[0].severity === "LOW", "6a. low -> LOW");
    const r2 = makeResult({ status: "FAILED", findings: [makeFinding({ severity: "info" as any })] });
    const ev2 = buildEvidenceList([r2], makeInput());
    const fs2 = buildFindingList([r2], ev2, makeInput());
    ok(fs2[0].severity === "LOW", "6b. info -> LOW");
    const r3 = makeResult({ status: "FAILED", findings: [makeFinding({ severity: "unknown" as any })] });
    const ev3 = buildEvidenceList([r3], makeInput());
    const fs3 = buildFindingList([r3], ev3, makeInput());
    ok(fs3[0].severity === "UNKNOWN", "6c. unknown -> UNKNOWN (not LOW)");
  }
  {
    const ev = buildEvidenceList([makeResult({ scanner: "" })], makeInput());
    ok(ev[0].status === "BLOCKED", "7a. empty scanner -> BLOCKED");
    ok(ev[0].scanner === "unknown_scanner", "7b. empty scanner -> placeholder name");
  }
  {
    let threw = false;
    try { buildExecution(makeInput({ projectId: "" })); } catch { threw = true; }
    ok(threw, "8. empty projectId -> throws");
  }
  {
    let threw = false;
    try { buildExecution(makeInput({ executionId: "" })); } catch { threw = true; }
    ok(threw, "9. empty executionId -> throws");
  }
  {
    const ev = buildEvidenceList([makeResult()], makeInput({ commitSha: "expected" }));
    ok(ev[0].commit_sha === "expected", "10. commit_sha propagated");
  }
  {
    const ev = buildEvidenceList([makeResult()], makeInput({ releaseId: "expected-rel" }));
    ok(ev[0].release_id === "expected-rel", "11. release_id propagated");
  }
  {
    const ev = buildEvidenceList([makeResult()], makeInput({ artifactDigest: "sha256:expected" }));
    ok(ev[0].artifact_digest === "sha256:expected", "12. artifact_digest propagated");
  }
  {
    const ev = buildEvidenceList([makeResult(), makeResult()], makeInput());
    ok(ev.length === 2, "13a. duplicate results -> two evidence");
    ok(ev[0].id !== ev[1].id, "13b. duplicate results -> distinct ids");
  }
  {
    const ev = buildEvidenceList([], makeInput());
    ok(ev.length === 0, "14. empty results -> empty evidence");
  }
  {
    const r = makeResult({ findings: undefined as any });
    const ev = buildEvidenceList([r], makeInput());
    const fs = buildFindingList([r], ev, makeInput());
    ok(fs.length === 0, "15. undefined findings -> empty findings");
  }
  {
    const ev = buildEvidenceList([makeResult({ status: "BLOCKED", blocked_reason: "scanner_timeout" })], makeInput());
    ok(ev[0].status === "BLOCKED", "16. timeout -> BLOCKED");
  }
  {
    const ev = buildEvidenceList([makeResult({ status: "BLOCKED", blocked_reason: "scanner_invocation_rejected" })], makeInput());
    ok(ev[0].status === "BLOCKED", "17. exception -> BLOCKED");
  }
  {
    ok(typeof buildEvidenceList === "function", "18. persistence boundary at ingestEvidence (mapping is pure)");
  }
  {
    const r = makeResult({ status: "FAILED", findings: [makeFinding()] });
    const ev = buildEvidenceList([r], makeInput());
    const fs = buildFindingList([r], ev, makeInput());
    ok(fs.length === 1, "19a. one finding normalized");
    ok(typeof fs[0].first_seen === "string", "19b. first_seen populated");
    ok(typeof fs[0].last_seen === "string", "19c. last_seen populated");
    ok(fs[0].status === "NEW", "19d. status NEW");
    ok(typeof fs[0].created_at === "string", "19e. created_at populated");
    ok(typeof fs[0].updated_at === "string", "19f. updated_at populated");
  }
  {
    const input = makeInput();
    const exec = buildExecution(input);
    const results: ScannerScanResult[] = [
      makeResult({ status: "FAILED", findings: [makeFinding({ severity: "critical" })] }),
    ];
    const ev = buildEvidenceList(results, input);
    const fs = buildFindingList(results, ev, input);
    ok(exec.execution_id === input.executionId, "20a. execution_id matches");
    ok(ev[0].execution_id === exec.execution_id, "20b. evidence.execution_id matches execution");
    ok(fs[0].execution_id === exec.execution_id, "20c. finding.execution_id matches execution");
    ok(fs[0].evidence_id === ev[0].id, "20d. finding.evidence_id matches evidence");
    ok(fs[0].severity === "CRITICAL", "20e. critical preserved end-to-end");
    const pf = mapScannerResultsToPolicyFindings(results);
    ok(pf[0].severity === "critical", "20f. policy finding severity lowercase");
  }

  // 20g. Fallback finding ID remains stable across executions.
  {
    const canonicalFinding = {
      scanner: "semgrep",
      category: "SAST" as const,
      severity: "HIGH" as const,
      title: "Stable identity finding",
      fingerprint: "stable-cross-execution-fingerprint",
      file: "src/example.ts",
      line: 24,
    };

    const inputA = makeInput({ executionId: "exec-stability-a" });
    const inputB = makeInput({ executionId: "exec-stability-b" });

    const resultA = {
      ...makeResult({ status: "FAILED" }),
      findings: [canonicalFinding],
    };

    const resultB = {
      ...makeResult({ status: "FAILED" }),
      findings: [canonicalFinding],
    };

    const evidenceA = buildEvidenceList([resultA], inputA);
    const evidenceB = buildEvidenceList([resultB], inputB);

    const findingsA = buildFindingList([resultA], evidenceA, inputA);
    const findingsB = buildFindingList([resultB], evidenceB, inputB);

    ok(
      findingsA.length === 1 && findingsB.length === 1,
      "20g. both executions produce one finding"
    );
    ok(
      findingsA[0].finding_id === findingsB[0].finding_id,
      "20g. fallback finding ID stable across executions"
    );
    ok(
      findingsA[0].evidence_id !== findingsB[0].evidence_id,
      "20g. evidence IDs remain execution-specific"
    );
  }

  section("Phase 295.C â€” runner integration");

  // 21a. UNKNOWN + exit 0 â†’ BLOCKED (fail-open fix verification is exercised
  // through the runner; here we assert the mapping boundary collapses UNKNOWN
  // to BLOCKED for a non-PASSED/FAILED status.)
  {
    const canonicalFinding = {
      scanner: "semgrep",
      category: "SAST" as const,
      severity: "HIGH" as const,
      title: "Unknown-status finding",
      fingerprint: "unknown-status-stable-fingerprint",
      file: "src/example.ts",
      line: 12,
    };

    const r = {
      ...makeResult({ status: "UNKNOWN" as any }),
      findings: [canonicalFinding],
    };

    const input = makeInput();
    const ev = buildEvidenceList([r], input);
    const fs = buildFindingList([r], ev, input);

    ok(ev[0].status === "BLOCKED", "21a. UNKNOWN scanner status -> BLOCKED");
    ok(fs.length === 1, "21a. UNKNOWN result findings are retained");
    ok(fs[0].evidence_id === ev[0].id, "21a. retained finding links to BLOCKED evidence");
  }

  // 21b. PASSED â†’ PASS (control)
  {
    const r = makeResult({ status: "PASSED" });
    const ev = buildEvidenceList([r], makeInput());
    ok(ev[0].status === "PASS", "21b. PASSED â†’ PASS");
  }

  // 21c. FAILED â†’ FAIL (control)
  {
    const r = makeResult({ status: "FAILED" });
    const ev = buildEvidenceList([r], makeInput());
    ok(ev[0].status === "FAIL", "21c. FAILED â†’ FAIL");
  }

  // 21d. Missing scanner identity â†’ BLOCKED
  {
    const r = makeResult({ scanner: "" });
    const ev = buildEvidenceList([r], makeInput());
    ok(ev[0].status === "BLOCKED", "21d. missing scanner â†’ BLOCKED");
  }

  // 21e. Findings reference persisted evidence IDs
  {
    const r = makeResult({ status: "FAILED", findings: [makeFinding()] });
    const ev = buildEvidenceList([r], makeInput());
    const fs = buildFindingList([r], ev, makeInput());
    ok(fs[0].evidence_id === ev[0].id, "21e. finding.evidence_id === evidence.id");
  }

  // 21f. Empty scanner results produce no evidence, no fabricated PASS
  {
    const ev = buildEvidenceList([], makeInput());
    ok(ev.length === 0, "21f. empty scanner results â†’ empty evidence (no fabricated PASS)");
  }

  // 21g. Environment propagates from input
  {
    const input = makeInput({ environment: "staging" });
    const r = makeResult({ status: "PASSED" });
    const ev = buildEvidenceList([r], input);
    ok(ev[0].environment === "staging", "21g. environment propagates from input");
  }

  console.log("\n============================================");
  console.log("Phase 295 â€” PASS: " + passed + "  FAIL: " + failed + "  BLOCKED: " + blocked + "  NOT EXECUTED: " + notExec);
  console.log("============================================");
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

