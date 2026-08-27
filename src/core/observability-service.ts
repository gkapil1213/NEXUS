import { NexusEngine } from "./db";
import { nid } from "./db";
import { Observation, HealthCheckResult, AlertRule, Alert, Incident } from "./observability-types";

export class ObservabilityService {
  constructor(private engine: NexusEngine) {}
    async getMetricHistory(metricName: string, limit = 20): Promise<Observation[]> {
    const all = await this.listObservations(1000);
    return all.filter((o) => o.metric === metricName).slice(-limit);
  }

  async getHealthHistory(target: string, limit = 20): Promise<HealthCheckResult[]> {
    const all = await this.listHealthChecks(1000);
    return all.filter((h) => h.target === target).slice(-limit);
  }

    async appendIncidentTimeline(incidentId: string, event: { type: string; timestamp: string; details?: string }): Promise<void> {
    const key = `incident_timeline:${incidentId}`;
    const existing = await this.engine.get<Array<{ type: string; timestamp: string; details?: string }>>("kv", key) ?? [];
    existing.push(event);
    await this.engine.put("kv", key, existing);
  }

  async getIncidentTimeline(incidentId: string): Promise<Array<{ type: string; timestamp: string; details?: string }>> {
    const key = `incident_timeline:${incidentId}`;
    return await this.engine.get<Array<{ type: string; timestamp: string; details?: string }>>("kv", key) ?? [];
  }
  async recordObservation(obs: Omit<Observation, "id" | "timestamp"> & { id?: string }): Promise<Observation> {
    const record: Observation = {
      id: obs.id || nid("obs"),
      timestamp: new Date().toISOString(),
      ...obs,
    };
    await this.engine.put("kv", `observation:${record.id}`, record);
    return record;
  }

  async getObservation(id: string): Promise<Observation | undefined> {
    return this.engine.get<Observation>("kv", `observation:${id}`);
  }

  async listObservations(limit = 50): Promise<Observation[]> {
    // Since we store in kv, we need to retrieve all keys with prefix; this is simplified.
    // In a real implementation, use a dedicated store and index.
    const all = await this.engine.all<Observation>("kv");
    // filter out non-observation entries
    const observations = all.filter((o: any) => (o as any)?.source && (o as any)?.metric);
    return observations.slice(-limit);
  }

  async recordHealthCheck(check: HealthCheckResult): Promise<void> {
    await this.engine.put("kv", `health:${check.id}`, check);
  }

  async getHealthCheck(id: string): Promise<HealthCheckResult | undefined> {
    return this.engine.get<HealthCheckResult>("kv", `health:${id}`);
  }

  async listHealthChecks(limit = 20): Promise<HealthCheckResult[]> {
    const all = await this.engine.all<HealthCheckResult>("kv");
    return all.filter((h: any) => (h as any)?.target).slice(-limit);
  }

  // Alerts
  async createAlertRule(rule: AlertRule): Promise<void> {
    await this.engine.put("kv", `alert_rule:${rule.id}`, rule);
  }

  async getAlertRule(id: string): Promise<AlertRule | undefined> {
    return this.engine.get<AlertRule>("kv", `alert_rule:${id}`);
  }

  async listAlertRules(): Promise<AlertRule[]> {
    const all = await this.engine.all<AlertRule>("kv");
    return all.filter((r: any) => (r as any)?.metric && (r as any)?.threshold !== undefined);
  }

  async createAlert(alert: Alert): Promise<void> {
    await this.engine.put("kv", `alert:${alert.id}`, alert);
  }

  async getAlert(id: string): Promise<Alert | undefined> {
    return this.engine.get<Alert>("kv", `alert:${id}`);
  }

  async listAlerts(limit = 20): Promise<Alert[]> {
    const all = await this.engine.all<Alert>("kv");
    return all.filter((a: any) => (a as any)?.fingerprint).slice(-limit);
  }

  // Incidents
  async createIncident(incident: Incident): Promise<Incident> {
    await this.engine.put("kv", `incident:${incident.id}`, incident);
    return incident;
  }

  async updateIncident(id: string, updates: Partial<Incident>): Promise<void> {
    const existing = await this.engine.get<Incident>("kv", `incident:${id}`);
    if (existing) {
      const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
      await this.engine.put("kv", `incident:${id}`, updated);
    }
  }

  async getIncident(id: string): Promise<Incident | undefined> {
    return this.engine.get<Incident>("kv", `incident:${id}`);
  }

  async listIncidents(limit = 20): Promise<Incident[]> {
    const all = await this.engine.all<Incident>("kv");
    return all.filter((i: any) => (i as any)?.title).slice(-limit);
  }
}