import Database from "better-sqlite3";

export class WorkerControlBudget {
  constructor(private db: Database.Database, private maxActions: number = 10) {}

  canExecute(scope: string): boolean {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(action_count),0) as total
      FROM control_budgets
      WHERE scope = ? AND window_end IS NULL OR window_end > ?
    `).get(scope, Date.now()) as any;
    return (row?.total ?? 0) < this.maxActions;
  }

  checkAndRecord(scope: string, maxActions?: number, windowMs?: number): boolean {
    if (!this.canExecute(scope)) return false;
    this.record(scope);
    return true;
  }

  record(scope: string): void {
    this.db.prepare(`
      INSERT INTO control_budgets (budget_id, scope, action_count, window_start, window_end, max_actions)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(
      `budget_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      scope,
      Date.now(),
      Date.now() + 3600000,
      this.maxActions
    );
  }
}
