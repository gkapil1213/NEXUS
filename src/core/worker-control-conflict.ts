import Database from "better-sqlite3";

export type ConflictResolution = "ALLOW" | "SERIALIZE" | "MERGE" | "DEFER" | "DENY";

export interface ControlConflict {
  actionA: string;
  actionB: string;
  resolution: ConflictResolution;
  reason: string;
}

export class WorkerControlConflictDetector {
  constructor(private db: Database.Database) {}

  evaluate(actionA: string, actionB: string): ConflictResolution {
    const key = [actionA, actionB].sort().join("|");
    switch (key) {
      case "SCALE_IN|SCALE_OUT":
        return "DENY";
      case "DRAIN_WORKER|MIGRATE_TO_SAME_WORKER":
        return "DEFER";
      case "RECOVERY|SCALE_IN":
        return "DEFER";
      case "QUARANTINE|DISPATCH":
        return "DENY";
      case "MAINTENANCE|NEW_WORK":
        return "DENY";
      case "REBALANCE|QUARANTINE":
        return "DENY";
      case "SCALE_IN|MIGRATE":
      case "MIGRATE|SCALE_IN":
        return "DEFER";
      default:
        return "ALLOW";
    }
  }

  persist(actionA: string, actionB: string, resolution: ConflictResolution): void {
    this.db.prepare(`
      INSERT INTO worker_control_conflicts (conflict_id, action_a, action_b, resolution, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `conf_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      actionA,
      actionB,
      resolution,
      JSON.stringify({}),
      Date.now()
    );
  }
}
