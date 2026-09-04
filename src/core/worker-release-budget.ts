import Database from "better-sqlite3";

export class WorkerReleaseBudget {
  constructor(private db: Database.Database, private maxActions: number = 3) {}

  canExecute(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM release_executions WHERE state IN ('EXECUTING','SUCCEEDED')").get() as any;
    return (row?.c ?? 0) < this.maxActions;
  }
}
