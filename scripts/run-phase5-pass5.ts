import { openEngine, resetEngineForTesting } from "../src/core/db";
import { CONFIG } from "../src/core/config";
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
  console.log("=== Phase 5 Pass 5: Persistent Runtime Observability Verification ===\n");

  const fs = await import("fs/promises");
  await fs.rm("./test-pass5.sqlite", { force: true });

  // Activate SQLite
  resetEngineForTesting();
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = "./test-pass5.sqlite";

  const engine = await openEngine();
  console.log(`Persistence engine: ${engine.kind}`);
  console.log(`Persistent database: ${engine.kind === "sqlite" ? "SQLite" : "BLOCKED (memory engine)"}\n`);

  const observability = new ObservabilityService(engine);
  const metricsAgent = new MetricsAgent(observability);
  const healthAgent = new HealthAgent(observability);
  const alertEngine = new AlertEngine(observability);
  const incidentService = new IncidentService(observability);
  const analysisService = new IncidentAnalysisService(observability);
  const recoveryPolicy = new RecoveryPolicyEngine();
  const recoveryAgent = new RecoveryAgent(recoveryPolicy);
  const verificationAgent = new VerificationAgent(observability);

  // Start HTTP service
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

  // Metrics and health
  await metricsAgent.collectProcessMetrics("nexus-test-service", "local");
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);
  healthy = false;
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);

  // Alert
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
    id: "obs-pass5",
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

  // Incident lifecycle
  const incidentId = await incidentService.createIncidentFromAlert(alerts[0], "default");
  await incidentService.acknowledgeIncident(incidentId);
  await incidentService.investigateIncident(incidentId);
  await incidentService.mitigateIncident(incidentId);

  // Recovery
  healthy = true;
  const diagnosis = await analysisService.analyze((await observability.getIncident(incidentId))!);
  await recoveryAgent.attemptRecovery(diagnosis, incidentId, "local", [], async () => true);
  const verification = await verificationAgent.verifyServiceHealth("http://localhost:3456/health");
  if (verification.status === "HEALTHY") {
    await incidentService.resolveIncident(incidentId);
    if (alerts.length > 0) await alertEngine.resolveAlert(alerts[0].id);
  }

  // Persistence after restart simulation
  (engine as any).close?.();
  resetEngineForTesting();
  const engine2 = await openEngine();
  const observability2 = new ObservabilityService(engine2);
  const incidentAfterRestart = await observability2.getIncident(incidentId);
  console.log(
    incidentAfterRestart
      ? "✅ Restart persistence verified"
      : "❌ Incident not found after restart"
  );

  server.close();
  (engine2 as any).close?.();
  console.log("\n✅ Phase 5 Pass 5 test completed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});