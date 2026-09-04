import Database from "better-sqlite3";

export class CoordinatorEpochManager {
  constructor(private db: Database.Database) {}

  create(coordinatorId: string, term: number, ttlMs: number = 60000): { epochId: string; term: number } {
    const epochId = `epoch_${term}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.db.prepare(`
      INSERT INTO control_plane_epochs (epoch_id, term, coordinator_id, created_at, expires_at, fenced)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(epochId, term, coordinatorId, Date.now(), Date.now() + ttlMs);
    return { epochId, term };
  }

  isValid(epochId: string): boolean {
    const row = this.db.prepare("SELECT * FROM control_plane_epochs WHERE epoch_id = ? AND fenced = 0 AND expires_at > ?").get(epochId, Date.now());
    return !!row;
  }

  fence(epochId: string): void {
    this.db.prepare("UPDATE control_plane_epochs SET fenced = 1 WHERE epoch_id = ?").run(epochId);
  }

  getLatestEpochId(): string | undefined {
    const row = this.db.prepare("SELECT epoch_id FROM control_plane_epochs ORDER BY term DESC LIMIT 1").get();
    return (row as any)?.epoch_id;
  }

  getCurrentTerm(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(term),0) as term FROM control_plane_epochs").get() as any;
    return row?.term ?? 0;
  }
}
