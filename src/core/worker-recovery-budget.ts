import Database from "better-sqlite3";

export class WorkerRecoveryBudget {
  constructor(private db: Database.Database, private maxActions: number = 3) {}

  canExecute(scope: string): boolean {
    const row = this.db.prepare("SELECT COALESCE(SUM(action_count),0) as total FROM recovery_budgets WHERE scope = ? AND window_end > ?").get(scope, Date.now()) as any;
    return (row?.total ?? 0) < this.maxActions;
  }

  checkAndRecord(scope: string): boolean {
    if (!this.canExecute(scope)) return false;
    this.db.prepare(`INSERT INTO recovery_budgets (budget_id, scope, action_count, max_actions, window_start, window_end) VALUES (?, ?, 1, ?, ?, ?)`).run(`rb_${Date.now()}_${Math.random().toString(36).slice(2)}`, scope, this.maxActions, Date.now(), Date.now() + 3600000);
    return true;
  }
}
