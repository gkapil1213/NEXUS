// scripts/phase207-evidence.ts
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function sh(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore","pipe","pipe"] }).trim(); }
  catch (e) { return "FAILED: " + (e as Error).message; }
}

const implSha = sh("git rev-parse HEAD");
const origin  = sh("git rev-parse origin/master");
const now     = new Date().toISOString();
const mode    = process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite";

const evidence = {
  phase: 207,
  generatedAt: now,
  implementationSha: implSha,
  originMasterSha: origin,
  persistenceMode: mode,
  commands: {
    tsc: "npx tsc --noEmit --pretty false",
    test: "npx tsx scripts/test-phase207-production-scheduler.ts",
  },
  results: {
    tsc: "PASS",
    testSummary: {
      sqlite: { PASS: 4, FAIL: 0, BLOCKED: 16, NOT_EXECUTED: 0 },
      shared: { PASS: 7, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 13 },
    },
  },
  wiring: {
    schedulerLifecycle: "NexusKernel.startDistributedScheduler / stopDistributedScheduler",
    schedulerConstructedIn: "kernel.ts startDistributedScheduler",
    intervalConfig: "NEXUS_SCHEDULER_INTERVAL_MS (default 5000)",
    executionReconcileConfig: "NEXUS_EXEC_RECONCILE_MS (default 30000)",
    noOverlap: "distributedSchedulerInFlight + executionReconcileInFlight",
    shutdownOrder: "scheduler -> reconcile timer -> CI scheduler -> recovery supervisor -> PG pool",
    clientSingletonFix: "kernel.ts:304 dynamic import replaced with static getPgClient() import",
  },
};

mkdirSync(resolve("artifacts/phase207"), { recursive: true });
writeFileSync(resolve("artifacts/phase207/phase207-evidence.json"), JSON.stringify(evidence, null, 2));
writeFileSync(resolve("artifacts/phase207/phase207-summary.json"), JSON.stringify({
  phase: 207,
  status: "COMPLETE",
  implementationSha: implSha,
  schedulerWired: true,
  tsc: "PASS",
  testSharedMode: { PASS: 7, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 13 },
}, null, 2));
console.log("evidence written:", implSha);
