import Database from "better-sqlite3";

export class WorkerReleasePlan {
  constructor(private db: Database.Database) {}

  create(releaseId: string, changeId: string, strategy: string, environment: string, idempotencyKey: string): boolean {
    try {
      this.db.prepare(`
        INSERT INTO release_plans (release_id, change_id, strategy, environment, state, idempotency_key, evidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?)
      `).run(releaseId, changeId, strategy, environment, idempotencyKey, JSON.stringify({}), Date.now(), Date.now());
      return true;
    } catch {
      return false;
    }
  }

  get(releaseId: string): any | undefined {
    return this.db.prepare("SELECT * FROM release_plans WHERE release_id = ?").get(releaseId);
  }

  updateState(releaseId: string, state: string): void {
    this.db.prepare("UPDATE release_plans SET state = ?, updated_at = ? WHERE release_id = ?").run(state, Date.now(), releaseId);
  }
}
