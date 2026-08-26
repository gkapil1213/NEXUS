import { HttpDASTProvider } from "../src/core/dast-agent.ts";

(async () => {
  const targetUrl = process.env.STAGING_URL ?? "https://nexus-staging-fwqk.onrender.com";
  console.log(`Running DAST against ${targetUrl}...`);

  const provider = new HttpDASTProvider(targetUrl);
  const result = await provider.scan();

  console.log("DAST Scan Results");
  console.log("=================");
  console.log(`Status: ${result.status}`);
  console.log(`Findings: ${result.findings.length}`);
  for (const f of result.findings) {
    console.log(`  • [${f.severity}] ${f.title} (${f.url})`);
    if (f.evidence) console.log(`    Evidence: ${f.evidence}`);
    if (f.remediation) console.log(`    Remediation: ${f.remediation}`);
  }
  if (result.blocked_reason) console.log(`Blocked: ${result.blocked_reason}`);

  const hasFailed = result.status === "FAILED";
  if (hasFailed) process.exit(1);
})();
