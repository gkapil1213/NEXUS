import { nid } from "./db";
import type { ObservabilitySummary } from "./observability";

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  condition: (summary: ObservabilitySummary) => boolean;
  severity: "critical" | "high" | "medium" | "low";
}

export interface Alert {
  id: string;
  rule_id: string;
  rule_name: string;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  timestamp: number;
}

export class AlertService {
  private rules: AlertRule[] = [
    {
      id: "HEALTH_FAILURE",
      name: "Health check failure",
      description: "Any failed health check triggers an alert",
      condition: (s) => s.health_checks_failed > 0,
      severity: "critical",
    },
    {
      id: "ERROR_RATE_HIGH",
      name: "High error rate",
      description: "Error rate exceeds 5%",
      condition: (s) => s.error_rate > 5,
      severity: "high",
    },
    {
      id: "DEPLOYMENT_FAILURE",
      name: "Deployment failure",
      description: "Any failed deployment triggers an alert",
      condition: (s) => s.deployments_failed > 0,
      severity: "high",
    },
    {
      id: "LATENCY_HIGH",
      name: "High latency",
      description: "Average latency exceeds 1000ms",
      condition: (s) => s.avg_latency_ms > 1000,
      severity: "medium",
    },
  ];

  evaluate(summary: ObservabilitySummary): Alert[] {
    const alerts: Alert[] = [];
    for (const rule of this.rules) {
      if (rule.condition(summary)) {
        alerts.push({
          id: nid("alt"),
          rule_id: rule.id,
          rule_name: rule.name,
          severity: rule.severity,
          message: rule.description,
          timestamp: Date.now(),
        });
      }
    }
    return alerts;
  }
}