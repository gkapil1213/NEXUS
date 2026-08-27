import { openEngine } from "../src/core/db";
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

  console.log("=== Phase 5 Pass 4: Production Observability Integration ===\n");

  // Start controlled HTTP service
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

  // 1. Collect metrics and initial health
  await metricsAgent.collectProcessMetrics("nexus-test-service", "local");
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);
  console.log("✅ Metrics and initial health collected");

  // 2. Induce failure
  healthy = false;
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);
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
  console.log("✅ Failure induced and recorded");

  // 3. Alert rule + evaluation
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
  const newAlerts = await alertEngine.evaluateRules();
  console.log(`✅ Alert triggered: ${newAlerts.length} new alert(s)`);

  // 4. Dedup check
  const before = (await observability.listAlerts(20)).filter(a => a.status === "TRIGGERED" || a.status === "ACKNOWLEDGED").length;
  await alertEngine.evaluateRules();
  const after = (await observability.listAlerts(20)).filter(a => a.status === "TRIGGERED" || a.status === "ACKNOWLEDGED").length;
  if (after > before) {
    console.log("❌ Alert dedup failed");
    process.exit(1);
  }
  console.log("✅ Alert deduplication verified");

  // 5. Incident lifecycle
  const alert = newAlerts[0];
  const incidentId = await incidentService.createIncidentFromAlert(alert, "default");
  console.log(`✅ Incident created: ${incidentId}`);

  await incidentService.acknowledgeIncident(incidentId);
  await incidentService.investigateIncident(incidentId);
  await incidentService.mitigateIncident(incidentId);
  console.log("✅ Incident transitions executed");

  // Illegal transition test
  try {
    await incidentService.closeIncident(incidentId);
    console.log("❌ Illegal transition succeeded (BUG)");
    process.exit(1);
  } catch (e: any) {
    console.log("✅ Illegal transition rejected:", e.message);
  }

  // 6. Diagnosis
  const incident = await observability.getIncident(incidentId);
  const diagnosis = await analysisService.analyze(incident!);
  console.log(`✅ Diagnosis: ${diagnosis.classification} (confidence: ${diagnosis.confidence})`);

  // 7. Recovery success
  healthy = true;
  const recoveryResult = await recoveryAgent.attemptRecovery(diagnosis, incidentId, "local", [], async () => true);
  console.log(`✅ Recovery attempt: ${recoveryResult.status}`);

  const verification = await verificationAgent.verifyServiceHealth("http://localhost:3456/health");
  console.log(`✅ Verification: ${verification.status} (${verification.details})`);

  if (verification.status === "HEALTHY") {
    await incidentService.resolveIncident(incidentId);
    await alertEngine.resolveAlert(alert.id);
    console.log("✅ Incident and alert resolved");
  } else {
    console.log("❌ Recovery verification failed");
    process.exit(1);
  }

  // 8. Timeline and history checks
  const timeline = await observability.getIncidentTimeline(incidentId);
  if (timeline.length < 5) {
    console.log("❌ Incident timeline incomplete");
    process.exit(1);
  }
  console.log(`✅ Incident timeline entries: ${timeline.length}`);

  const metricsHistory = await observability.getMetricHistory("process_uptime_seconds", 5);
  if (metricsHistory.length === 0) {
    console.log("❌ Metric history missing");
    process.exit(1);
  }
  console.log(`✅ Metric history entries: ${metricsHistory.length}`);

  const healthHistory = await observability.getHealthHistory("http://localhost:3456/health", 10);
  if (healthHistory.length < 2) {
    console.log("❌ Health history incomplete");
    process.exit(1);
  }
  console.log(`✅ Health history entries: ${healthHistory.length}`);

  // 9. Recovery failure scenario
  console.log("\n--- Testing recovery failure ---");
  healthy = false;
  await healthAgent.checkHttpHealth("http://localhost:3456/health", 1000);
  const alert2 = (await alertEngine.evaluateRules())[0] || alert;
  const incident2Id = await incidentService.createIncidentFromAlert(alert2, "default");
  const failedRecovery = await recoveryAgent.attemptRecovery(diagnosis, incident2Id, "local", [], async () => false);
  const incident2 = await observability.getIncident(incident2Id);
  if (incident2?.status === "RESOLVED") {
    console.log("❌ Incident incorrectly resolved after failed recovery");
    process.exit(1);
  }
  console.log("✅ Recovery failure handled correctly; incident remains unresolved");

  // Cleanup
  server.close();
  console.log("\n✅ Phase 5 Pass 4 integration test passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});