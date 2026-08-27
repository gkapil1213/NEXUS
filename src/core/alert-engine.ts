import { ObservabilityService } from "./observability-service";
import { AlertRule, Alert } from "./observability-types";
import { nid } from "./db";

export class AlertEngine {
  constructor(private observability: ObservabilityService) {}

  async evaluateRules(): Promise<Alert[]> {
    const rules = await this.observability.listAlertRules();
    const triggeredAlerts: Alert[] = [];

    for (const rule of rules) {
      const observations = await this.observability.listObservations(100);
      const recent = observations.filter(
        (obs) =>
          obs.metric === rule.metric &&
          obs.environment === rule.environment &&
          obs.service === rule.service &&
          new Date(obs.timestamp).getTime() > Date.now() - rule.window_seconds * 1000,
      );

      const trigger = recent.some((obs) => {
        switch (rule.operator) {
          case ">": return obs.value > rule.threshold;
          case "<": return obs.value < rule.threshold;
          case ">=": return obs.value >= rule.threshold;
          case "<=": return obs.value <= rule.threshold;
          case "==": return obs.value === rule.threshold;
          case "!=": return obs.value !== rule.threshold;
          default: return false;
        }
      });

      if (!trigger) continue;

      const fingerprint = `${rule.environment}:${rule.service}:${rule.metric}:${rule.threshold}`;
      const existingAlerts = await this.observability.listAlerts(20);
      const existing = existingAlerts.find(
        (a) => a.fingerprint === fingerprint && a.status !== "RESOLVED" && a.status !== "SUPPRESSED",
      );

      if (!existing) {
        const alert: Alert = {
          id: nid("alert"),
          rule_id: rule.id,
          fingerprint,
          status: "TRIGGERED",
          severity: rule.severity,
          message: `${rule.metric} ${rule.operator} ${rule.threshold} for ${rule.service} in ${rule.environment}`,
          first_triggered_at: new Date().toISOString(),
          last_triggered_at: new Date().toISOString(),
          observations: recent.map((o) => o.id),
        };
        await this.observability.createAlert(alert);
        triggeredAlerts.push(alert);
      } else {
        // Update last triggered time and merge observation ids (deduplication)
        const updated: Alert = {
          ...existing,
          last_triggered_at: new Date().toISOString(),
          observations: [...new Set([...existing.observations, ...recent.map((o) => o.id)])],
        };
        await this.observability.createAlert(updated);
      }
    }
    return triggeredAlerts;
  }

  async acknowledgeAlert(alertId: string): Promise<void> {
    const alert = await this.observability.getAlert(alertId);
    if (!alert) throw new Error("Alert not found");
    if (alert.status !== "TRIGGERED") throw new Error("Invalid transition to ACKNOWLEDGED");
    alert.status = "ACKNOWLEDGED";
    await this.observability.createAlert(alert);
  }

  async resolveAlert(alertId: string): Promise<void> {
    const alert = await this.observability.getAlert(alertId);
    if (!alert) throw new Error("Alert not found");
    if (alert.status === "RESOLVED") return;
    alert.status = "RESOLVED";
    await this.observability.createAlert(alert);
  }

  async reopenAlert(alertId: string): Promise<void> {
    const alert = await this.observability.getAlert(alertId);
    if (!alert) throw new Error("Alert not found");
    if (alert.status !== "RESOLVED") throw new Error("Only RESOLVED alerts can be reopened");
    alert.status = "TRIGGERED";
    await this.observability.createAlert(alert);
  }
}