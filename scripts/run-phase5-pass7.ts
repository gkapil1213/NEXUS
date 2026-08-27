import { spawnSync } from "child_process";
import { openEngine, resetEngineForTesting } from "../src/core/db";
import { ObservabilityService } from "../src/core/observability-service";
import { MetricsAgent } from "../src/core/metrics-agent";
import { HealthAgent } from "../src/core/health-agent";
import { AlertEngine } from "../src/core/alert-engine";
import { IncidentService } from "../src/core/incident-service";
import { IncidentAnalysisService } from "../src/core/incident-analysis";
import { RecoveryPolicyEngine } from "../src/core/recovery-policy-engine";
import { RecoveryAgent } from "../src/core/recovery-agent";
import { VerificationAgent } from "../src/core/verification-agent";
import http from "http";

async function main() {
  console.log("=== Phase 5 Pass 7: SQLite Persistent Runtime Verification ===\n");

  const dbPath = "./test-pass7.sqlite";
  const fs = await import("fs/promises");
  await fs.rm(dbPath, { force: true });

  process.env.NEXUS_PERSISTENCE_ENGINE = "sqlite";
  process.env.NEXUS_DB_PATH = dbPath;

  const engine = await openEngine();
  console.log(`Persistence engine: ${engine.kind}`);
  if (engine.kind !== "sqlite") {
    console.log("FATAL: SQLite engine not active");
    process.exit(1);
  }

  // Real write/read in same process
  const testKey = "metric:pass7";
  await engine.put("kv", testKey, { value: 42, timestamp: new Date().toISOString() });
  const readBack = await engine.get<{ value: number }>("kv", testKey);
  if (!readBack || readBack.value !== 42) {
    console.log("FAILED: write/read mismatch");
    process.exit(1);
  }
  console.log("✅ Real SQLite write/read succeeded");

  // Close engine to simulate shutdown
  (engine as any).close?.();
  resetEngineForTesting(); // clear singleton

  // Spawn a separate process to test restart persistence
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-phase5-pass7-reader.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXUS_PERSISTENCE_ENGINE: "sqlite",
        NEXUS_DB_PATH: dbPath,
      },
      encoding: "utf8",
    }
  );
  console.log("Child stdout:", child.stdout);
  if (child.status !== 0 || !child.stdout.includes("METRIC_OK:42")) {
    console.log("❌ Restart persistence test failed");
    process.exit(1);
  }
  console.log("✅ Real separate-process restart verification passed");

  // Now run full observability flow on SQLite (reopen engine)
  const engine2 = await openEngine();
  const observability = new ObservabilityService(engine2);
  const metricsAgent = new MetricsAgent(observability);
  const healthAgent = new HealthAgent(observability);
  const alertEngine = new AlertEngine(observability);
  const incidentService = new IncidentService(observability);
  const analysisService = new IncidentAnalysisService(observability);
  const recoveryPolicy = new RecoveryPolicyEngine();
  const recoveryAgent = new RecoveryAgent(recoveryPolicy);
  const verificationAgent = new VerificationAgent(observability);

  // Start test HTTP service
  let healthy = true;
  const server = http.createServer((req, res) => {
    if (healthy && req.url === "/health") {
      res.writeHead(200);
      res.end("OK");
    } else {
      res.writeHead(500);
      res.end("FAIL");
    }
  });
  await new Promise<void>((resolve) => server.listen(3456, () => resolve()));

  await metricsAgent.collectProcessMetrics("nexus-test-service", "local");
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);
  healthy = false;
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);

  await observability.createAlertRule({
    id: "rule-health-failure",
    metric: "health_failure",
    operator: ">",
    threshold: 0,
    severity: "HIGH",
    environment: "local",
    service: "nexus-test-service",
    window_seconds: 60,
  } as any);

  await observability.recordObservation({
    id: "obs-pass7",
    source: "test",
    environment: "local",
    service: "nexus-test-service",
    metric: "health_failure",
    value: 1,
    unit: "boolean",
    status: "OBSERVED",
  });

  const alerts = await alertEngine.evaluateRules();
  if (alerts.length === 0) {
    console.log("❌ Alert not triggered");
    process.exit(1);
  }

  const incidentId = await incidentService.createIncidentFromAlert(alerts[0], "default");
  await incidentService.acknowledgeIncident(incidentId);
  await incidentService.investigateIncident(incidentId);
  await incidentService.mitigateIncident(incidentId);

  healthy = true;
  const diagnosis = await analysisService.analyze((await observability.getIncident(incidentId))!);
  const recovery = await recoveryAgent.attemptRecovery(diagnosis, incidentId, "local", [], async () => true);
  const verification = await verificationAgent.verifyServiceHealth("http://localhost:3456/health");
  if (verification.status !== "HEALTHY") {
    console.log("❌ Recovery verification failed");
    process.exit(1);
  }
  await incidentService.resolveIncident(incidentId);
  await alertEngine.resolveAlert(alerts[0].id);

  console.log("✅ Full observability flow on SQLite completed");
  console.log("✅ Incident resolved and persisted");

  server.close();
  (engine2 as any).close?.();
  console.log("\n✅ Phase 5 Pass 7 SQLite persistence test passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});