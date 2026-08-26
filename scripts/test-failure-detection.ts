import { ObservabilityService } from "../src/core/observability.ts";
import { AlertService } from "../src/core/alerting.ts";
import { FailureDetectionAgent } from "../src/core/failure-detection.ts";

(async () => {
  const obs = new ObservabilityService();
  const alertService = new AlertService();

  // Real failed health checks against a dead endpoint
  const badUrl = "http://localhost:9"; // port 9 is typically closed
  console.log(`Running real failing health checks against ${badUrl}...`);

  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    try {
      const res = await fetch(`${badUrl}/health`);
      const elapsed = Date.now() - start;
      obs.recordHealthCheck(badUrl, res.ok, res.status, elapsed);
      obs.recordMetric("request_count", 1);
      if (!res.ok) obs.recordMetric("error_count", 1);
      obs.recordMetric("latency", elapsed);
      console.log(`  attempt ${i + 1}: HTTP ${res.status}`);
    } catch (e) {
      const elapsed = Date.now() - start;
      obs.recordHealthCheck(badUrl, false, null, elapsed, (e as Error).message);
      obs.recordMetric("request_count", 1);
      obs.recordMetric("error_count", 1);
      obs.recordMetric("health_failures", 1);
      console.log(`  attempt ${i + 1}: FAILED (${(e as Error).message})`);
    }
  }

  const summary = obs.computeSummary();
  const alerts = alertService.evaluate(summary);
  const agent = new FailureDetectionAgent();
  const diagnosis = agent.analyze(summary, obs.getHealthHistory(), obs.getDeploymentHistory(), alerts);

  console.log("\nFailure Diagnosis");
  console.log("=================");
  console.log(`Category: ${diagnosis.category}`);
  console.log(`Confidence: ${diagnosis.confidence}`);
  console.log(`Evidence: ${diagnosis.evidence.join(", ") || "none"}`);
  console.log(`Recommended action: ${diagnosis.recommended_action}`);
  console.log(`Uncertainty: ${diagnosis.uncertainty}`);

  if (diagnosis.category !== "UNKNOWN") {
    console.log("\nFailure detection test passed!");
    process.exit(0);
  } else {
    console.error("Failure detection failed to classify a real failure");
    process.exit(1);
  }
})();