import { ObservabilityService } from "./observability-service";
import { Alert, Incident } from "./observability-types";
import { nid } from "./db";

export class IncidentService {
  constructor(private observability: ObservabilityService) {}

  async createIncidentFromAlert(alert: Alert, tenantId = "default"): Promise<string> {
    const now = new Date().toISOString();
    const incident: Incident = {
      id: nid("incident"),
      tenant_id: tenantId,
      environment: "production",
      service: "nexus",
      severity: alert.severity,
      title: `Incident from alert: ${alert.message}`,
      description: `Alert ${alert.id} triggered for ${alert.fingerprint}`,
      trigger_alert_id: alert.id,
      status: "OPEN",
      created_at: now,
      updated_at: now,
    };
    await this.observability.createIncident(incident);
    await this.observability.appendIncidentTimeline(incident.id, { type: "OPEN", timestamp: now });
    return incident.id;
  }

  async createIncident(incident: Incident): Promise<string> {
    const now = new Date().toISOString();
    incident.created_at = incident.created_at || now;
    incident.updated_at = incident.updated_at || now;
    await this.observability.createIncident(incident);
    await this.observability.appendIncidentTimeline(incident.id, { type: "OPEN", timestamp: incident.created_at });
    return incident.id;
  }

  async updateIncident(id: string, updates: Partial<Incident>): Promise<void> {
    await this.observability.updateIncident(id, updates);
  }

  async acknowledgeIncident(id: string): Promise<void> {
    const incident = await this.observability.getIncident(id);
    if (!incident) throw new Error("Incident not found");
    if (incident.status !== "OPEN") throw new Error("Only OPEN incidents can be acknowledged");
    const now = new Date().toISOString();
    await this.observability.updateIncident(id, { status: "ACKNOWLEDGED", updated_at: now });
    await this.observability.appendIncidentTimeline(id, { type: "ACKNOWLEDGED", timestamp: now });
  }

  async investigateIncident(id: string): Promise<void> {
    const incident = await this.observability.getIncident(id);
    if (!incident) throw new Error("Incident not found");
    if (incident.status !== "ACKNOWLEDGED") throw new Error("Only ACKNOWLEDGED incidents can be investigated");
    const now = new Date().toISOString();
    await this.observability.updateIncident(id, { status: "INVESTIGATING", updated_at: now });
    await this.observability.appendIncidentTimeline(id, { type: "INVESTIGATING", timestamp: now });
  }

  async mitigateIncident(id: string): Promise<void> {
    const incident = await this.observability.getIncident(id);
    if (!incident) throw new Error("Incident not found");
    if (incident.status !== "INVESTIGATING") throw new Error("Only INVESTIGATING incidents can be mitigated");
    const now = new Date().toISOString();
    await this.observability.updateIncident(id, { status: "MITIGATING", updated_at: now });
    await this.observability.appendIncidentTimeline(id, { type: "MITIGATING", timestamp: now });
  }

  async resolveIncident(id: string): Promise<void> {
    const incident = await this.observability.getIncident(id);
    if (!incident) throw new Error("Incident not found");
    if (incident.status !== "MITIGATING" && incident.status !== "ACKNOWLEDGED")
      throw new Error("Incident must be MITIGATING or ACKNOWLEDGED to resolve");
    const now = new Date().toISOString();
    await this.observability.updateIncident(id, { status: "RESOLVED", resolved_at: now, updated_at: now });
    await this.observability.appendIncidentTimeline(id, { type: "RESOLVED", timestamp: now });
  }

  async closeIncident(id: string): Promise<void> {
    const incident = await this.observability.getIncident(id);
    if (!incident) throw new Error("Incident not found");
    if (incident.status !== "RESOLVED") throw new Error("Only RESOLVED incidents can be closed");
    const now = new Date().toISOString();
    await this.observability.updateIncident(id, { status: "CLOSED", updated_at: now });
    await this.observability.appendIncidentTimeline(id, { type: "CLOSED", timestamp: now });
  }
}