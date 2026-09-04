import Database from "better-sqlite3";

export class JobOwnershipManager {
  constructor(private db: Database.Database) {}

  acquire(jobId: string, coordinatorId: string, epochId: string): boolean {
    try {
      this.db.prepare(`
        INSERT INTO global_job_ownership (
          ownership_id, job_id, coordinator_id, epoch_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'OWNED', ?, ?)
      `).run(
        `ownership_${jobId}`,
        jobId,
        coordinatorId,
        epochId,
        Date.now(),
        Date.now()
      );
      return true;
    } catch {
      return false; // duplicate job ownership
    }
  }

  release(jobId: string): void {
    this.db.prepare("UPDATE global_job_ownership SET state = 'RELEASED', updated_at = ? WHERE job_id = ?").run(Date.now(), jobId);
  }

  getOwner(jobId: string): { coordinatorId: string; epochId: string; state: string } | undefined {
    const row = this.db.prepare("SELECT * FROM global_job_ownership WHERE job_id = ?").get(jobId) as any;
    return row ? { coordinatorId: row.coordinator_id, epochId: row.epoch_id, state: row.state } : undefined;
  }
}
