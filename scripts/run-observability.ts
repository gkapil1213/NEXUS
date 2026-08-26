import { ObservabilityService } from "../src/core/observability.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";

(async () => {
  const obs = new ObservabilityService();
  const stagingUrl = process.env.STAGING_URL ?? "https://nexus-staging-fwqk.onrender.com";

  // 1. Perform real health checks
  console.log(`Running health checks against ${stagingUrl}...`);
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    try {
      const res = await fetch(`${stagingUrl}/health`);
      const elapsed = Date.now() - start;
      obs.recordHealthCheck(stagingUrl, res.ok, res.status, elapsed, res.ok ? null : `HTTP ${res.status}`);
      obs.recordMetric("request_count", 1);
      if (!res.ok) obs.recordMetric("error_count", 1);
      obs.recordMetric("latency", elapsed);
      console.log(`  health attempt ${i + 1}: ${res.status} (${elapsed}ms)`);
    } catch (e) {
      const elapsed = Date.now() - start;
      obs.recordHealthCheck(stagingUrl, false, null, elapsed, (e as Error).message);
      obs.recordMetric("request_count", 1);
      obs.recordMetric("error_count", 1);
      obs.recordMetric("health_failures", 1);
      console.log(`  health attempt ${i + 1}: FAILED (${(e as Error).message})`);
    }
  }

  // 2. Try to import deployment history from rollback-state.json if it exists
  try {
    const rollbackStatePath = path.join(process.cwd(), "rollback-state.json");
    const data = JSON.parse(await readFile(rollbackStatePath, "utf-8"));
    if (data.deployments && Array.isArray(data.deployments)) {
      for (const dep of data.deployments) {
        obs.recordDeploymentEvent(dep.deployment_id, dep.environment, dep.status, dep.image_digest);
        if (dep.status === "FAILED") obs.recordMetric("deployment_failures", 1);
        obs.recordMetric("deployment_duration", 0); // not tracked in state; placeholder
      }
      console.log(`Imported ${data.deployments.length} deployment events from rollback-state.json`);
    }
  } catch {
    console.log("No rollback-state.json found, skipping deployment history import.");
  }

  // 3. Output summary
  const summary = obs.computeSummary();
  console.log("\nObservability Summary");
  console.log("=====================");
  console.log(`Total requests: ${summary.total_requests}`);
  console.log(`Errors: ${summary.error_count}`);
  console.log(`Error rate: ${summary.error_rate.toFixed(2)}%`);
  console.log(`Avg latency: ${summary.avg_latency_ms.toFixed(1)} ms`);
  console.log(`Health checks: ${summary.health_checks_total} (failed: ${summary.health_checks_failed})`);
  console.log(`Deployments: ${summary.deployments_total} (failed: ${summary.deployments_failed})`);
  if (summary.recent_health) {
    console.log(`\nLast health check:`);
    console.log(`  Endpoint: ${summary.recent_health.endpoint}`);
    console.log(`  OK: ${summary.recent_health.ok}`);
    console.log(`  Status: ${summary.recent_health.status_code}`);
    console.log(`  Latency: ${summary.recent_health.response_time_ms} ms`);
  }
  if (summary.recent_deployment) {
    console.log(`\nLast deployment:`);
    console.log(`  ID: ${summary.recent_deployment.deployment_id}`);
    console.log(`  Environment: ${summary.recent_deployment.environment}`);
    console.log(`  Status: ${summary.recent_deployment.status}`);
    console.log(`  Digest: ${summary.recent_deployment.image_digest}`);
  }

  console.log("\nObservability run completed.");
})();