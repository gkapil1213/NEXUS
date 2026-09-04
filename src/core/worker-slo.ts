import Database from "better-sqlite3";

export type SloState = "HEALTHY" | "WARNING" | "BREACHING" | "CRITICAL" | "UNKNOWN";

export interface SloDefinition {
  sloId: string;
  service: string;
  metric: string;
  target: number;
  windowMs: number;
  criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  policyVersion?: number;
  enabled: boolean;
}

export class WorkerSlo {
  constructor(private db: Database.Database) {}

  register(def: SloDefinition): void {
    this.db.prepare(`
      INSERT INTO worker_slo_definitions (
        slo_id, service, metric, target, window_ms, criticality,
        policy_version, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      def.sloId, def.service, def.metric, def.target, def.windowMs,
      def.criticality, def.policyVersion, def.enabled ? 1 : 0,
      Date.now(), Date.now()
    );
  }

  validate(def: SloDefinition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!def.sloId) errors.push("sloId required");
    if (!def.service) errors.push("service required");
    if (!def.metric) errors.push("metric required");
    if (def.target <= 0) errors.push("target must be positive");
    if (def.windowMs <= 0) errors.push("windowMs must be positive");
    if (!["LOW","MEDIUM","HIGH","CRITICAL"].includes(def.criticality)) errors.push("invalid criticality");
    return { valid: errors.length === 0, errors };
  }

  classify(sliValue: number, target: number, criticality: string): SloState {
    if (!Number.isFinite(sliValue) || !Number.isFinite(target) || target <= 0) return "UNKNOWN";
    const ratio = sliValue / target;
    if (criticality === "CRITICAL" && ratio < 0.8) return "CRITICAL";
    if (ratio < 0.9) return "BREACHING";
    if (ratio < 0.98) return "WARNING";
    return "HEALTHY";
  }

  get(sloId: string): SloDefinition | undefined {
    const row = this.db.prepare("SELECT * FROM worker_slo_definitions WHERE slo_id = ?").get(sloId) as any;
    if (!row) return undefined;
    return {
      sloId: row.slo_id,
      service: row.service,
      metric: row.metric,
      target: row.target,
      windowMs: row.window_ms,
      criticality: row.criticality,
      policyVersion: row.policy_version,
      enabled: !!row.enabled,
    };
  }
}
