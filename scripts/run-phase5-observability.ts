import { openEngine } from "../src/core/db";
import { ObservabilityService } from "../src/core/observability-service";
import { MetricsAgent } from "../src/core/metrics-agent";
import { HealthAgent } from "../src/core/health-agent";
import { AlertEngine } from "../src/core/alert-engine";
import { IncidentService } from "../src/core/incident-service";

async function main() {
  const engine = await openEngine();
  const observability = new ObservabilityService(engine);
  const metricsAgent = new MetricsAgent(observability);
  const healthAgent = new HealthAgent(observability);
  const alertEngine = new AlertEngine(observability);
  const incidentService = new IncidentService(observability);

  console.log("=== Phase 5: Production Observability ===\n");

  // 1. Collect process metrics
  await metricsAgent.collectProcessMetrics("nexus", "local");
  console.log("✅ Metrics collected");

  // 2. Health check (process)
  await healthAgent.checkProcessHealth();
  console.log("✅ Process health recorded");

  // 3. HTTP health check to local (likely fails -> BLOCKED)
  await healthAgent.checkHttpHealth("http://localhost:3000", 1500);
  console.log("✅ HTTP health checked (may be BLOCKED)");

  // 4. Create a simple alert rule
  const rule = {
    id: "rule-test",
    metric: "memory_rss_bytes",
    operator: ">",
    threshold: 0, // always triggers
    severity: "LOW",
    environment: "local",
    service: "nexus",
    window_seconds: 60,
  };
  await observability.createAlertRule(rule as any);
  console.log("✅ Alert rule created");

  // 5. Evaluate alerts
  const alerts = await alertEngine.evaluateRules();
  console.log(`✅ Alert evaluation produced ${alerts.length} alert(s)`);

  // 6. Create incident from first alert
  if (alerts.length > 0) {
    const incidentId = await incidentService.createIncidentFromAlert(alerts[0]);
    console.log(`✅ Incident created: ${incidentId}`);
  }

  // 7. Show observations
  const obs = await observability.listObservations(5);
  console.log("\nRecent observations:");
  for (const o of obs) {
    console.log(`  ${o.metric} = ${o.value} ${o.unit}`);
  }

  console.log("\n✅ Phase 5 observability smoke test passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});