import { RealSecurityScanner } from "../src/core/security-scanners.ts";

const scanner = new RealSecurityScanner();
const res = await scanner.runAll("./test-fixture");

const summary = res.results.map((r) => ({
  kind: r.kind,
  scanner: r.scanner,
  status: r.status,
  findings: r.findings.length,
  blocked_reason: r.blocked_reason,
  duration_ms: r.duration_ms,
}));

console.log(JSON.stringify({ capabilities: res.capabilities, summary }, null, 2));
