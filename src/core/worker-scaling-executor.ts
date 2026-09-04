import Database from "better-sqlite3";

export type ScalingExecutionStatus = "EXECUTION_UNAVAILABLE" | "SUCCEEDED" | "FAILED" | "DUPLICATE" | "EXPIRED";

export class WorkerScalingExecutor {
  constructor(private db: Database.Database) {}

  execute(planId: string): ScalingExecutionStatus {
    const plan = this.db.prepare("SELECT * FROM scaling_plans WHERE plan_id = ?").get(planId) as any;
    if (!plan) return "FAILED";
    if (plan.status !== "PLANNED" && plan.status !== "APPROVED") return "DUPLICATE";
    if (plan.expires_at < Date.now()) return "EXPIRED";
    // In this environment, no real infrastructure executor is configured.
    this.db.prepare("UPDATE scaling_plans SET status = 'EXECUTION_UNAVAILABLE' WHERE plan_id = ?").run(planId);
    return "EXECUTION_UNAVAILABLE";
  }
}
