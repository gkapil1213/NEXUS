import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the core suite from production. Every other test script uses an
// isolated temp SQLite file (or :memory:); this runner must do the same or
// it accumulates state in nexus.sqlite across runs.
if (!process.env.NEXUS_DB_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-core-"));
  process.env.NEXUS_DB_PATH = join(dir, "core.sqlite");
  process.env.NEXUS_PERSISTENCE_ENGINE = "sqlite";
}

// Dynamic import so CONFIG reads the env vars set above.
const { runPhase1Suite } = await import("../src/core/tests.ts");

console.log("NEXUS CORE VERIFICATION");
console.log("========================");
console.log("");

const started = Date.now();

try {
  const report = await runPhase1Suite();

  const duration = Date.now() - started;

  console.log(`Engine: ${report.engine ?? "NexusKernel"}`);
  console.log(`Passed: ${report.passed}`);
  console.log(`Failed: ${report.failed}`);
  console.log(`Blocked: ${report.blocked}`);
  console.log(`Duration: ${report.duration_ms ?? duration}ms`);
  console.log("");

  console.log("--------------------------------");
  console.log("TEST RESULTS");
  console.log("--------------------------------");

  for (const result of report.results ?? []) {
    const status = String(result.status ?? "UNKNOWN").toUpperCase();
    console.log(`[${status}] ${result.name}`);

    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }

    if (result.evidence) {
      console.log(`  Evidence: ${result.evidence}`);
    }
  }

  console.log("");
  console.log("--------------------------------");
  console.log("SUMMARY");
  console.log("--------------------------------");
  console.log(`PASS:    ${report.passed}`);
  console.log(`FAIL:    ${report.failed}`);
  console.log(`BLOCKED: ${report.blocked}`);
  console.log(`TOTAL:   ${(report.passed ?? 0) + (report.failed ?? 0) + (report.blocked ?? 0)}`);

  process.exitCode = report.failed > 0 ? 1 : 0;
  process.exit(process.exitCode);
} catch (error) {
  console.error("");
  console.error("CORE TEST RUNNER FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
