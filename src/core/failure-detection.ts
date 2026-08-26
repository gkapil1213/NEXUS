import type { ObservabilitySummary, HealthRecord, DeploymentEventRecord } from "./observability";
import type { Alert } from "./alerting";

export type FailureCategory =
  | "APPLICATION"
  | "CONTAINER"
  | "NETWORK"
  | "DATABASE"
  | "DEPENDENCY"
  | "CONFIGURATION"
  | "SECURITY"
  | "INFRASTRUCTURE"
  | "RESOURCE"
  | "UNKNOWN";

export interface FailureDiagnosis {
  category: FailureCategory;
  confidence: number; // 0..1
  evidence: string[];
  recommended_action: string;
  uncertainty: string;
}

export class FailureDetectionAgent {
  analyze(
    summary: ObservabilitySummary,
    healthHistory: HealthRecord[],
    deploymentHistory: DeploymentEventRecord[],
    alerts: Alert[],
  ): FailureDiagnosis {
    const evidence: string[] = [];

    if (summary.health_checks_failed > 0) {
      evidence.push(`${summary.health_checks_failed} failed health check(s)`);
    }
    if (summary.error_rate > 5) {
      evidence.push(`Error rate ${summary.error_rate.toFixed(2)}% exceeds threshold`);
    }
    if (summary.deployments_failed > 0) {
      evidence.push(`${summary.deployments_failed} failed deployment(s)`);
    }
    if (alerts.length > 0) {
      evidence.push(`${alerts.length} alert(s) generated`);
    }
    const lastDeployment = deploymentHistory[deploymentHistory.length - 1];
    if (lastDeployment && lastDeployment.status === "FAILED") {
      evidence.push(`Most recent deployment ${lastDeployment.deployment_id} failed`);
    }
    const lastHealth = healthHistory[healthHistory.length - 1];
    if (lastHealth && lastHealth.error) {
      evidence.push(`Most recent health check error: ${lastHealth.error}`);
    }

    let category: FailureCategory = "UNKNOWN";
    let confidence = 0.2;
    let recommended_action = "Investigate recent logs and metrics";
    let uncertainty = "Insufficient data to determine exact root cause";

    if (summary.deployments_failed > 0 && summary.health_checks_failed > 0) {
      category = "APPLICATION";
      confidence = 0.7;
      recommended_action = "Review the most recent deployment and application logs";
      uncertainty = "Failure may be caused by the new release or configuration change";
    } else if (summary.health_checks_failed > 0 && summary.error_rate === 0) {
      category = "NETWORK";
      confidence = 0.6;
      recommended_action = "Check connectivity to the service and DNS/routing configuration";
      uncertainty = "Health checks failed but no application errors were recorded";
    } else if (summary.health_checks_failed > 0 && summary.error_rate > 5) {
      category = "RESOURCE";
      confidence = 0.5;
      recommended_action = "Inspect container resources (CPU/memory) and scaling limits";
      uncertainty = "High error rate with health failures may indicate resource exhaustion";
    } else if (alerts.some((a) => a.rule_id === "SECURITY")) {
      category = "SECURITY";
      confidence = 0.8;
      recommended_action = "Investigate security alerts and recent access logs";
      uncertainty = "Security alert triggered";
    } else if (lastHealth && lastHealth.error && lastHealth.error.includes("fetch failed")) {
      category = "NETWORK";
      confidence = 0.9;
      recommended_action = "Check network reachability and firewall rules";
      uncertainty = "Fetch failure indicates network-level issue";
    }

    return {
      category,
      confidence,
      evidence,
      recommended_action,
      uncertainty,
    };
  }
}