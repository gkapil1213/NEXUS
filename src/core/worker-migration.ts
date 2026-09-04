import Database from "better-sqlite3";

export class WorkerMigration {
  constructor(private db: Database.Database) {}

  createMigration(jobId: string, sourceWorkerId: string, destinationWorkerId: string, idempotencyKey: string): boolean {
    try {
      this.db.prepare(`
        INSERT INTO worker_migrations (
          migration_id, job_id, source_worker_id, destination_worker_id, status,
          reservation_id, idempotency_key, evidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, ?, ?, ?)
      `).run(
        `mig_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        jobId,
        sourceWorkerId,
        destinationWorkerId,
        idempotencyKey,
        JSON.stringify({}),
        Date.now(),
        Date.now()
      );
      return true;
    } catch {
      return false; // duplicate idempotency
    }
  }

  updateStatus(migrationId: string, status: string): void {
    this.db.prepare("UPDATE worker_migrations SET status = ?, updated_at = ? WHERE migration_id = ?").run(status, Date.now(), migrationId);
  }

  get(migrationId: string): any | undefined {
    return this.db.prepare("SELECT * FROM worker_migrations WHERE migration_id = ?").get(migrationId);
  }
}
