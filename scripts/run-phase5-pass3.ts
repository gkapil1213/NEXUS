import { openEngine } from "../src/core/db";
import { ObservabilityService } from "../src/core/observability-service";
import { MetricsAgent } from "../src/core/metrics-agent";
import { HealthAgent } from "../src/core/health-agent";
import { AlertEngine } from "../src/core/alert-engine";
import { IncidentService } from "../src/core/incident-service";
import { IncidentAnalysisService } from "../src/core/incident-analysis";
import { RecoveryPolicyEngine } from "../src/core/recovery-policy-engine";
import { RecoveryAgent, RecoveryAttempt } from "../src/core/recovery-agent";
import { VerificationAgent } from "../src/core/verification-agent";
import http from "http";
import { nid } from "../src/core/db";

async function main() {
  const engine = await openEngine();
  const observability = new ObservabilityService(engine);
  const metricsAgent = new MetricsAgent(observability);
  const healthAgent = new HealthAgent(observability);
  const alertEngine = new AlertEngine(observability);
  const incidentService = new IncidentService(observability);
  const analysisService = new IncidentAnalysisService(observability);
  const recoveryPolicy = new RecoveryPolicyEngine();
  const recoveryAgent = new RecoveryAgent(recoveryPolicy);
  const verificationAgent = new VerificationAgent(observability);

  console.log("=== Phase 5 Pass 3: Production Observability Hardening ===\n");

  // Start a controllable HTTP service
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
  console.log("Test service started on port 3456");

  // 1. Metrics collection
  await metricsAgent.collectProcessMetrics("nexus-test-service", "local");
  console.log("✅ Metrics collected");

  // 2. Health check (initial healthy)
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);
  console.log("✅ Initial health check performed");

  // Introduce failure
  healthy = false;
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);
  console.log("✅ Failure health check performed (UNHEALTHY)");

  // Create an alert rule on a custom metric that we'll record to signal failure
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

  // Record a metric that triggers the rule
  await observability.recordObservation({
    id: nid("obs"),
    source: "test",
    environment: "local",
    service: "nexus-test-service",
    metric: "health_failure",
    value: 1,
    unit: "boolean",
    status: "OBSERVED",
  });
  console.log("✅ Failure metric recorded");

  // Evaluate alert rules
  const newAlerts = await alertEngine.evaluateRules();
  console.log(`✅ Alert evaluation produced ${newAlerts.length} new alert(s)`);
  if (newAlerts.length === 0) {
    console.log("❌ Expected at least one alert");
    server.close();
    process.exit(1);
  }

  // Test deduplication: evaluate again, should not create another active alert
  const beforeCount = (await observability.listAlerts(10)).filter(a => a.status === "TRIGGERED" || a.status === "ACKNOWLEDGED").length;
  await alertEngine.evaluateRules();
  const afterCount = (await observability.listAlerts(10)).filter(a => a.status === "TRIGGERED" || a.status === "ACKNOWLEDGED").length;
  console.log(`✅ Dedup check: before=${beforeCount}, after=${afterCount}`);
  if (afterCount > beforeCount) {
    console.log("❌ Alert storm detected");
    server.close();
    process.exit(1);
  }

  // Create incident from alert
  const alert = newAlerts[0];
  const incidentId = await incidentService.createIncidentFromAlert(alert, "default");
  console.log(`✅ Incident created: ${incidentId}`);

  // Incident lifecycle transitions
  await incidentService.acknowledgeIncident(incidentId);
  console.log("✅ Incident acknowledged");
  await incidentService.investigateIncident(incidentId);
  console.log("✅ Incident investigating");
  await incidentService.mitigateIncident(incidentId);
  console.log("✅ Incident mitigating");

  // Test illegal transition: close from mitigating should fail
  try {
    await incidentService.closeIncident(incidentId);
    console.log("❌ Illegal transition succeeded (BUG)");
    server.close();
    process.exit(1);
  } catch (e: any) {
    console.log("✅ Illegal transition rejected:", e.message);
  }

  // Diagnosis
  const incident = await observability.getIncident(incidentId);
  const diagnosis = await analysisService.analyze(incident!);
  console.log(`✅ Diagnosis: ${diagnosis.classification} (confidence: ${diagnosis.confidence})`);

  // Recovery: restore service, attempt recovery, verify
  const attempts: RecoveryAttempt[] = [];
  const recoveryResult = await recoveryAgent.attemptRecovery(
    diagnosis,
    incidentId,
    "local",
    attempts,
    async () => { healthy = true; return true; }
  );
  attempts.push(recoveryResult);
  console.log(`✅ Recovery attempt: ${recoveryResult.status}`);

  // Verify health after recovery
  const verification = await verificationAgent.verifyServiceHealth("http://localhost:3456/health");
  console.log(`✅ Verification: ${verification.status} (${verification.details})`);

  if (verification.status === "HEALTHY") {
    await incidentService.resolveIncident(incidentId);
    console.log("✅ Incident resolved");
    await alertEngine.resolveAlert(alert.id);
    console.log("✅ Alert resolved");
  } else {
    console.log("❌ Recovery verification failed");
    server.close();
    process.exit(1);
  }

  // Test recovery failure scenario
  console.log("\n--- Testing recovery failure ---");
  // Create new incident with persistent failure
  healthy = false;
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);
  const alert2 = (await alertEngine.evaluateRules())[0] || newAlerts[0]; // may reuse existing
  const incident2Id = await incidentService.createIncidentFromAlert(alert2, "default");
  // Try recovery that fails
  const failedAttempt = await recoveryAgent.attemptRecovery(
    diagnosis,
    incident2Id,
    "local",
    [],
    async () => { healthy = false; return false; }
  );
  console.log(`✅ Recovery failure attempt: ${failedAttempt.status}`);
  const incident2 = await observability.getIncident(incident2Id);
  if (incident2?.status === "RESOLVED") {
    console.log("❌ Incident incorrectly resolved after failed recovery");
    server.close();
    process.exit(1);
  } else {
    console.log("✅ Incident remains unresolved after failed recovery");
  }

  // Cleanup
  server.close();
  console.log("\n✅ Phase 5 Pass 3 hardening test passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});