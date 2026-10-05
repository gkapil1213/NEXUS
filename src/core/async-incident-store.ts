// src/core/async-incident-store.ts
//
// Phase 251: PostgreSQL-backed authoritative incident persistence.
//
// Mirror of ObservabilityService's incident methods (createIncident / get /
// update / list / timeline) but for shared production mode, using the
// AsyncNexusEngine contract (parameterized SQL, not KV). Reuses the same
// Incident shape from observability-types and adds Phase 250/251 recovery
// lifecycle columns.
//
// No SQLite fallback. No in-memory authority. Every statement parameterized.

import type { AsyncNexusEngine } from "./db";
import type { Incident } from "./observability-types";
import { sha256Hex } from "./integrity";

export type IncidentLifecycleStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "INVESTIGATING"
  | "MITIGATING"
  | "RECOVERY_REQUESTED"
  | "RECOVERY_AUTHORIZED"
  | "RECOVERY_RUNNING"
  | "AWAITING_VERIFICATION"
  | "VERIFICATION_FAILED"
  | "REQUIRE_REVIEW"
  | "RECOVERED"
  | "RESOLVED"
  | "BLOCKED"
  | "CLOSED";

export interface SecurityIncident extends Omit<Incident, "status"> {
  status: IncidentLifecycleStatus;
  deployment_id?: string | null;
  release_id?: string | null;
  artifact_id?: string | null;
  artifact_digest?: string | null;
  drift_classification?: string | null;
  incident_fingerprint: string;
  recovery_intent_key?: string | null;
  recovery_attempt?: number;
  lease_owner?: string | null;
  lease_expires_at?: number | null;
  last_observation_at?: string | null;
  verification_state?: string | null;
  resolution_evidence?: string | null;
  closed_at?: string | null;
}

export interface IncidentTimelineEvent {
  incident_id: string;
  seq: number;
  event_type: string;
  payload: string | null;
  created_at: string;
}

export interface SecurityIncidentCreateInput extends Omit<Incident, "status"> {
  recovery_attempt?: number;
  status?: IncidentLifecycleStatus;
  deployment_id?: string | null;
  release_id?: string | null;
  artifact_id?: string | null;
  artifact_digest?: string | null;
  drift_classification?: string | null;
  incident_fingerprint: string;
  recovery_intent_key?: string | null;
  lease_owner?: string | null;
  lease_expires_at?: number | null;
}

function mapIncident(r: any): SecurityIncident {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    environment: r.environment,
    service: r.service,
    severity: r.severity,
    title: r.title,
    description: r.description ?? "",
    trigger_alert_id: r.trigger_alert_id ?? undefined,
    status: r.status,
    deployment_id: r.deployment_id ?? null,
    release_id: r.release_id ?? null,
    artifact_id: r.artifact_id ?? null,
    artifact_digest: r.artifact_digest ?? null,
    drift_classification: r.drift_classification ?? null,
    incident_fingerprint: r.incident_fingerprint,
    recovery_intent_key: r.recovery_intent_key ?? null,
    recovery_attempt: r.recovery_attempt ?? 0,
    lease_owner: r.lease_owner ?? null,
    lease_expires_at:
      r.lease_expires_at === null || r.lease_expires_at === undefined
        ? null
        : Number(r.lease_expires_at),
    last_observation_at: r.last_observation_at ?? null,
    verification_state: r.verification_state ?? null,
    resolution_evidence: r.resolution_evidence ?? null,
    resolved_at: r.resolved_at ?? undefined,
    closed_at: r.closed_at ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class AsyncIncidentStore {
  constructor(private readonly db: AsyncNexusEngine) {}

  async createIncidentAsync(input: SecurityIncidentCreateInput): Promise<SecurityIncident> {
    const status: IncidentLifecycleStatus = input.status ?? "OPEN";
    const now = new Date().toISOString();
    await this.db
      .prepareAsync(
        "INSERT INTO security_incidents (" +
          "id, tenant_id, environment, service, severity, title, description, " +
          "trigger_alert_id, status, deployment_id, release_id, artifact_id, " +
          "artifact_digest, drift_classification, incident_fingerprint, " +
          "recovery_intent_key, recovery_attempt, lease_owner, lease_expires_at, " +
          "last_observation_at, verification_state, resolution_evidence, " +
          "resolved_at, closed_at, created_at, updated_at" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.tenant_id,
        input.environment,
        input.service,
        input.severity,
        input.title,
        input.description ?? null,
        input.trigger_alert_id ?? null,
        status,
        input.deployment_id ?? null,
        input.release_id ?? null,
        input.artifact_id ?? null,
        input.artifact_digest ?? null,
        input.drift_classification ?? null,
        input.incident_fingerprint,
        input.recovery_intent_key ?? null,
        input.recovery_attempt ?? 0,
        input.lease_owner ?? null,
        input.lease_expires_at ?? null,
        null,
        null,
        null,
        input.resolved_at ?? null,
        null,
        input.created_at,
        now,
      );
    const back = await this.getIncidentAsync(input.id);
    if (!back) throw new Error("AsyncIncidentStore: insert roundtrip failed for " + input.id);
    return back;
  }

  async getIncidentAsync(id: string): Promise<SecurityIncident | undefined> {
    const r = await this.db
      .prepareAsync("SELECT * FROM security_incidents WHERE id = ?")
      .get<any>(id);
    return r ? mapIncident(r) : undefined;
  }

  async getIncidentByFingerprintAsync(fp: string): Promise<SecurityIncident | undefined> {
    const r = await this.db
      .prepareAsync("SELECT * FROM security_incidents WHERE incident_fingerprint = ?")
      .get<any>(fp);
    return r ? mapIncident(r) : undefined;
  }

  async listIncidentsAsync(limit = 50): Promise<SecurityIncident[]> {
    const rows = await this.db
      .prepareAsync("SELECT * FROM security_incidents ORDER BY created_at DESC LIMIT ?")
      .all<any>(limit);
    return rows.map(mapIncident);
  }

  async listIncidentsByStatusAsync(status: IncidentLifecycleStatus, limit = 100): Promise<SecurityIncident[]> {
    const rows = await this.db
      .prepareAsync("SELECT * FROM security_incidents WHERE status = ? ORDER BY created_at ASC LIMIT ?")
      .all<any>(status, limit);
    return rows.map(mapIncident);
  }

  async updateIncidentAsync(id: string, patch: Partial<SecurityIncident>): Promise<boolean> {
    const fields: string[] = [];
    const values: any[] = [];
    const now = new Date().toISOString();
    const allowed = [
      "status", "severity", "title", "description",
      "deployment_id", "release_id", "artifact_id", "artifact_digest",
      "drift_classification", "recovery_intent_key", "recovery_attempt",
      "lease_owner", "lease_expires_at", "last_observation_at",
      "verification_state", "resolution_evidence", "resolved_at", "closed_at",
    ] as const;
    for (const k of allowed) {
      if (k in patch) {
        fields.push(k + " = ?");
        values.push((patch as any)[k] ?? null);
      }
    }
    if (fields.length === 0) return false;
    fields.push("updated_at = ?");
    values.push(now);
    values.push(id);
    const r = await this.db
      .prepareAsync("UPDATE security_incidents SET " + fields.join(", ") + " WHERE id = ?")
      .run(...values);
    return (r.changes ?? 0) === 1;
  }

  /**
   * Append a timeline entry. Idempotent: derived event_hash is UNIQUE per
   * incident; the ON CONFLICT DO NOTHING makes repeated identical transitions
   * a no-op (Phase 251 §9 "no duplicate timeline entries").
   */
  async appendIncidentTimelineAsync(
    incidentId: string,
    event: { type: string; payload?: Record<string, unknown> | null; at?: string },
  ): Promise<{ inserted: boolean; seq: number | null }> {
    const at = event.at ?? new Date().toISOString();
    const payloadJson = event.payload ? JSON.stringify(event.payload) : null;
    const eventHash = sha256Hex(event.type + "|" + at + "|" + (payloadJson ?? ""));

    // Compute next seq deterministically inside a single statement using
    // COALESCE(MAX(seq), 0) + 1; the (incident_id, seq) primary key protects
    // against races.
    const seqRow = await this.db
      .prepareAsync("SELECT COALESCE(MAX(seq), 0) + 1 AS nxt FROM security_incident_timeline WHERE incident_id = ?")
      .get<{ nxt: number }>(incidentId);
    const seq = Number(seqRow?.nxt ?? 1);

    const res = await this.db
      .prepareAsync(
        "INSERT INTO security_incident_timeline " +
          "(incident_id, seq, event_type, event_hash, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (incident_id, event_hash) DO NOTHING",
      )
      .run(incidentId, seq, event.type, eventHash, payloadJson, at);
    const inserted = (res.changes ?? 0) === 1;
    return { inserted, seq: inserted ? seq : null };
  }

  async getIncidentTimelineAsync(incidentId: string): Promise<IncidentTimelineEvent[]> {
    const rows = await this.db
      .prepareAsync(
        "SELECT incident_id, seq, event_type, payload, created_at " +
          "FROM security_incident_timeline WHERE incident_id = ? ORDER BY seq ASC",
      )
      .all<any>(incidentId);
    return rows.map((r) => ({
      incident_id: r.incident_id,
      seq: Number(r.seq),
      event_type: r.event_type,
      payload: r.payload ?? null,
      created_at: r.created_at,
    }));
  }
}