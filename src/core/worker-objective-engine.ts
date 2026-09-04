import Database from "better-sqlite3";

export interface ObjectiveDefinition {
  objectiveId: string;
  version: number;
  weight: number;
  direction: "minimize" | "maximize";
  target?: number;
  threshold?: number;
  priority: number;
  hardConstraint: boolean;
  enabled: boolean;
  policyVersion?: number;
}

export class WorkerObjectiveEngine {
  constructor(private db: Database.Database) {}

  registerObjective(obj: ObjectiveDefinition): void {
    this.db.prepare(`
      INSERT INTO worker_control_objectives (
        objective_id, version, weight, direction, target, threshold,
        priority, hard_constraint, enabled, policy_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      obj.objectiveId,
      obj.version,
      obj.weight,
      obj.direction,
      obj.target,
      obj.threshold,
      obj.priority,
      obj.hardConstraint ? 1 : 0,
      obj.enabled ? 1 : 0,
      obj.policyVersion,
      Date.now()
    );
  }

  getActiveObjectives(): ObjectiveDefinition[] {
    const rows = this.db.prepare("SELECT * FROM worker_control_objectives WHERE enabled = 1 ORDER BY priority ASC").all();
    return rows.map((r: any) => this.map(r));
  }

  private map(row: any): ObjectiveDefinition {
    return {
      objectiveId: row.objective_id,
      version: row.version,
      weight: row.weight,
      direction: row.direction,
      target: row.target,
      threshold: row.threshold,
      priority: row.priority,
      hardConstraint: !!row.hard_constraint,
      enabled: !!row.enabled,
      policyVersion: row.policy_version,
    };
  }
}
