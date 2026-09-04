import Database from "better-sqlite3";

export class WorkerHealingLoop {
  constructor(private db: Database.Database) {}

  freeze(reason: string, scope: string, correlationId?: string): void {
    this.db.prepare(`
      INSERT INTO worker_control_freezes (freeze_id, reason, scope, state, triggered_at, correlation_id)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?)
    `).run(`freeze_${Date.now()}_${Math.random().toString(36).slice(2)}`, reason, scope, Date.now(), correlationId);
  }

  isFrozen(): boolean {
    const row = this.db.prepare("SELECT 1 FROM worker_control_freezes WHERE state = 'ACTIVE' LIMIT 1").get();
    return !!row;
  }

  releaseFrozen(): void {
    this.db.prepare("UPDATE worker_control_freezes SET state = 'RELEASED', released_at = ? WHERE state = 'ACTIVE'").run(Date.now());
  }
}
