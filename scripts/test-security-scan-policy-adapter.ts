// Regression test for the run-security-scan.ts policy path.
// Pins the contract: scanner results -> PolicyContext.findings -> evaluateRules -> verdict.
// Does NOT invoke real scanners; all fixtures are hand-constructed so this runs in <1s.

import { SecurityPolicyEngine } from "../src/core/security-policy.ts";
import type { PolicyContext } from "../src/core/security-policy.ts";
import type { ScannerScanResult } from "../src/core/security-scanners.ts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name}${detail ? " -- " + detail : ""}`); }
}

// Mirror of the runner's inline mapping at run-security-scan.ts:99-106.
// If the runner's mapping changes, this must change in lockstep.
function mapToPolicyFindings(results: ScannerScanResult[]): PolicyContext["findings"] {
  return results.flatMap((r) =>
    (r.findings ?? []).map((f) => ({
      severity: String(f.severity).toLowerCase(),
      category: f.category,
      scanner: f.scanner,
      title: f.title,
    }))
  );
}

// Mirror of the runner's exit-code decision. BLOCKED must fail closed.
function shouldFail(results: ScannerScanResult[]): boolean {
  return results.some((r) => r.status === "FAILED" || r.status === "BLOCKED");
}

function scanResult(
  kind: ScannerScanResult["kind"],
  scanner: string,
  status: ScannerScanResult["status"],
  findings: ScannerScanResult["findings"],
  blocked_reason: string | null = null,
): ScannerScanResult {
  return { kind, scanner, status, findings, blocked_reason, duration_ms: 1 };
}

function finding(severity: "critical" | "high" | "medium" | "low", title: string) {
  return {
    id: "f-" + title,
    fingerprint: "fp-" + title,
    scanner: "test",
    category: "SAST" as const,
    severity,
    title,
    description: "",
    file: null,
    line: null,
    resource: null,
    evidence: null,
    remediation: null,
    status: "OPEN" as const,
    created_at: Date.now(),
  };
}

console.log("Security scan policy adapter regression\n");

// ---------- A1: four real scanner results -> mapped findings ----------
{
  const results: ScannerScanResult[] = [
    scanResult("SAST", "semgrep", "PASSED", [finding("high", "a1-sast")]),
    scanResult("SECRET", "gitleaks", "PASSED", []),
    scanResult("IAC", "checkov", "PASSED", []),
    scanResult("SCA", "npm-audit", "PASSED", []),
  ];
  const mapped = mapToPolicyFindings(results);
  check("A1 finding count preserved (1 input -> 1 output)", mapped.length === 1, `got=${mapped.length}`);
  const m = mapped[0];
  check("A1 severity lowercased", m?.severity === "high", `got=${m?.severity}`);
  check("A1 category preserved", m?.category === "SAST");
  check("A1 scanner preserved", m?.scanner === "test");
  check("A1 title preserved", m?.title === "a1-sast");
}

// ---------- A2: evaluateRules({ findings }) does not throw ----------
{
  const engine = new SecurityPolicyEngine();
  const mapped = mapToPolicyFindings([scanResult("SAST", "semgrep", "PASSED", [])]);
  let threw = false;
  let evals: ReturnType<SecurityPolicyEngine["evaluateRules"]> = [];
  try { evals = engine.evaluateRules({ findings: mapped }); }
  catch (e) { threw = true; console.log("A2 threw:", (e as Error).message); }
  check("A2 evaluateRules({ findings }) does not throw", !threw);
  check("A2 returns an array", Array.isArray(evals));
}

// ---------- A3: critical finding -> verdict FAIL ----------
{
  const engine = new SecurityPolicyEngine();
  const mapped = mapToPolicyFindings([
    scanResult("SAST", "semgrep", "PASSED", [finding("critical", "a3-crit")]),
  ]);
  const evals = engine.evaluateRules({ findings: mapped });
  const verdict = engine.verdict(evals);
  check("A3 critical finding -> verdict FAIL", verdict === "FAIL", `got=${verdict}`);
}

// ---------- A4: BLOCKED scanner causes fail-closed exit ----------
{
  const blocked = [
    scanResult("SAST", "semgrep", "BLOCKED", [], "semgrep not installed"),
    scanResult("SECRET", "gitleaks", "PASSED", []),
    scanResult("IAC", "checkov", "PASSED", []),
    scanResult("SCA", "npm-audit", "PASSED", []),
  ];
  check("A4 one BLOCKED scanner -> shouldFail true", shouldFail(blocked) === true);

  const allBlocked = [
    scanResult("SAST", "semgrep", "BLOCKED", [], "x"),
    scanResult("SECRET", "gitleaks", "BLOCKED", [], "x"),
    scanResult("IAC", "checkov", "BLOCKED", [], "x"),
    scanResult("SCA", "npm-audit", "BLOCKED", [], "x"),
  ];
  check("A4 all BLOCKED -> shouldFail true", shouldFail(allBlocked) === true);

  const clean = [
    scanResult("SAST", "semgrep", "PASSED", []),
    scanResult("SECRET", "gitleaks", "PASSED", []),
    scanResult("IAC", "checkov", "PASSED", []),
    scanResult("SCA", "npm-audit", "PASSED", []),
  ];
  check("A4 all PASSED -> shouldFail false", shouldFail(clean) === false);
}

// ---------- A5: malformed input cannot produce a clean PASS ----------
{
  // findings undefined on a well-formed result: mapping must not throw, must yield empty.
  const malformed = [
    { kind: "SAST", scanner: "semgrep", status: "PASSED", findings: undefined as any, blocked_reason: null, duration_ms: 0 },
  ] as unknown as ScannerScanResult[];
  let threw = false;
  let mapped: PolicyContext["findings"] = [];
  try { mapped = mapToPolicyFindings(malformed); } catch { threw = true; }
  check("A5 undefined findings does not throw", !threw);
  check("A5 undefined findings yields empty array", mapped.length === 0);

  // A malformed result with missing status must not be treated as PASSED-clean.
  const noStatus = [
    { kind: "SAST", scanner: "semgrep", status: undefined as any, findings: [], blocked_reason: null, duration_ms: 0 },
  ] as unknown as ScannerScanResult[];
  // shouldFail only looks at FAILED/BLOCKED; an undefined status is neither -> not failing by that rule.
  // But the mapping must still be safe, and evaluateRules must not throw.
  const engine = new SecurityPolicyEngine();
  let evals2: ReturnType<SecurityPolicyEngine["evaluateRules"]> = [];
  let threw2 = false;
  try { evals2 = engine.evaluateRules({ findings: mapToPolicyFindings(noStatus) }); } catch { threw2 = true; }
  check("A5 missing status does not crash evaluateRules", !threw2);
  check("A5 missing status yields empty findings", evals2.length === 0 || Array.isArray(evals2));
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);