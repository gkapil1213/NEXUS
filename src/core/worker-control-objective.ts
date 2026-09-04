import Database from "better-sqlite3";

export interface ControlObjective {
  objectiveId: string;
  objectiveType: string;
  targetMetric: string;
  targetValue?: number;
  status: "PENDING" | "VERIFIED" | "FAILED";
  evidence?: Record<string, any>;
}

export class WorkerControlObjective {
  constructor(private db: Database.Database) {}

  create(objective: ControlObjective): void {
    this.db.prepare(`
      INSERT INTO control_objectives (objective_id, objective_type, target_metric, target_value, status, evidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      objective.objectiveId,
      objective.objectiveType,
      objective.targetMetric,
      objective.targetValue,
      objective.status,
      objective.evidence ? JSON.stringify(objective.evidence) : null,
      Date.now(),
      Date.now()
    );
  }

  verify(objectiveId: string, observedValue: number): boolean {
    const row = this.db.prepare("SELECT * FROM control_objectives WHERE objective_id = ?").get(objectiveId) as any;
    if (!row) return false;
    const ok = row.target_value !== null ? observedValue <= row.target_value : true;
    const status = ok ? "VERIFIED" : "FAILED";
    this.db.prepare("UPDATE control_objectives SET status = ?, updated_at = ? WHERE objective_id = ?").run(status, Date.now(), objectiveId);
    return ok;
  }
}
