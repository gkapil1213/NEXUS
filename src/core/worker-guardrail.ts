import Database from "better-sqlite3";

export class WorkerGuardrail {
  constructor(private db: Database.Database) {}

  evaluate(actionType: string, affectedWorkers: number, resourceDelta: number, fleetPercentage: number): { allowed: boolean; reason: string } {
    // Check basic hard guardrail: fleet percentage <= 0.5, affectedWorkers <= 10, resourceDelta bounded
    if (fleetPercentage > 0.5) return { allowed: false, reason: "blast_radius_too_high" };
    if (affectedWorkers > 10) return { allowed: false, reason: "too_many_workers_affected" };
    if (Math.abs(resourceDelta) > 100) return { allowed: false, reason: "resource_delta_too_large" };
    const row = this.db.prepare("SELECT * FROM worker_control_guardrails WHERE guardrail_type = ? AND enabled = 1").get(actionType) as any;
    if (row && row.threshold && fleetPercentage > row.threshold) return { allowed: false, reason: "guardrail_threshold_exceeded" };
    return { allowed: true, reason: "ok" };
  }
}
