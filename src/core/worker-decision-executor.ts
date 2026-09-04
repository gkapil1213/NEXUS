import Database from "better-sqlite3";

export type DecisionExecutionStatus = "UNAVAILABLE" | "SUCCEEDED" | "FAILED" | "DUPLICATE";

export class WorkerDecisionExecutor {
  constructor(private db: Database.Database) {}

  execute(decisionId: string): DecisionExecutionStatus {
    const row = this.db.prepare("SELECT * FROM unified_decisions WHERE decision_id = ?").get(decisionId) as any;
    if (!row) return "FAILED";
    if (row.state !== "AUTHORIZED") return "DUPLICATE";
    // No real executor adapter configured in this environment.
    this.db.prepare("UPDATE unified_decisions SET state = 'EXECUTION_UNAVAILABLE' WHERE decision_id = ?").run(decisionId);
    return "UNAVAILABLE";
  }
}
