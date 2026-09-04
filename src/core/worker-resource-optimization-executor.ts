import Database from "better-sqlite3";

export type OptimizationExecutionStatus = "UNAVAILABLE" | "SUCCEEDED" | "FAILED" | "DUPLICATE" | "EXPIRED";

export class WorkerResourceOptimizationExecutor {
  constructor(private db: Database.Database) {}

  execute(optimizationId: string): OptimizationExecutionStatus {
    const plan = this.db.prepare("SELECT * FROM resource_optimization_plans WHERE optimization_id = ?").get(optimizationId) as any;
    if (!plan) return "FAILED";
    if (plan.status !== "PLANNED" && plan.status !== "APPROVED") return "DUPLICATE";
    // No real infrastructure executor configured in this environment.
    this.db.prepare("UPDATE resource_optimization_plans SET status = 'UNAVAILABLE' WHERE optimization_id = ?").run(optimizationId);
    return "UNAVAILABLE";
  }
}
