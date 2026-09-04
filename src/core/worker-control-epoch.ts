import Database from "better-sqlite3";

export class WorkerControlEpoch {
  constructor(private db: Database.Database) {}

  create(policyVersion: number, ttlMs: number = 60000): string {
    const epochId = `epoch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.db.prepare(`
      INSERT INTO worker_control_epochs (epoch_id, policy_version, state_hash, created_at, expires_at, invalidated)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(epochId, policyVersion, "unset", Date.now(), Date.now() + ttlMs);
    return epochId;
  }

  isValid(epochId: string): boolean {
    const row = this.db.prepare(
      "SELECT * FROM worker_control_epochs WHERE epoch_id = ? AND invalidated = 0 AND expires_at > ?"
    ).get(epochId, Date.now());
    return !!row;
  }

  invalidate(epochId: string): void {
    this.db.prepare("UPDATE worker_control_epochs SET invalidated = 1 WHERE epoch_id = ?").run(epochId);
  }
}
