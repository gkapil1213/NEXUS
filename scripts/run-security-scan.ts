import { RealSecurityScanner } from "../src/core/security-scanners.ts";

(async () => {
  const scanner = new RealSecurityScanner();
  const result = await scanner.runAll(".");

  for (const r of result.results) {
    console.log(
      r.kind +
      ": " +
      r.status +
      " (" +
      r.findings.length +
      " findings) " +
      (r.blocked_reason ?? "")
    );
  }
})();
