import Database from "better-sqlite3";
import { ControlActionType } from "./worker-control-action";

export type ExecutorResult =
  | "CONTROL_PLANE_ONLY"
  | "SUCCEEDED"
  | "FAILED"
  | "UNSUPPORTED_EXTERNAL_EXECUTION";

export class WorkerControlExecutor {
  constructor(private db: Database.Database) {}

  execute(actionType: ControlActionType, targetId?: string): ExecutorResult {
    // These actions mutate control-plane state.
    switch (actionType) {
      case "DRAIN_WORKER":
        if (targetId) {
          this.db.prepare("UPDATE worker_fleet_state SET draining = 1 WHERE worker_id = ?").run(targetId);
          return "SUCCEEDED";
        }
        return "FAILED";
      case "RESUME_WORKER":
        if (targetId) {
          this.db.prepare("UPDATE worker_fleet_state SET draining = 0 WHERE worker_id = ?").run(targetId);
          return "SUCCEEDED";
        }
        return "FAILED";
      case "SCALE_OUT":
      case "SCALE_IN":
        // External infrastructure operation unsupported in this environment.
        return "CONTROL_PLANE_ONLY";
      case "REBALANCE_WORK":
      case "REQUEUE_JOB":
      case "RECONCILE_CAPACITY":
      case "RECONCILE_LEASE":
      case "RECOVER_JOB":
        // These are real control-plane actions but implemented elsewhere.
        return "CONTROL_PLANE_ONLY";
      default:
        return "UNSUPPORTED_EXTERNAL_EXECUTION";
    }
  }
}
