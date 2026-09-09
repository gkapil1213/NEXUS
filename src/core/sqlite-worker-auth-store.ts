import { WorkerAuthStore } from "./worker-authentication";
import { NexusEngine } from "./db";


function sha256Hex(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

export class SqliteWorkerAuthStore implements WorkerAuthStore {
  constructor(private db: NexusEngine) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_credentials (
        worker_id TEXT PRIMARY KEY,
        credential_hash TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  setCredential(workerId: string, credential: string): void {
    const hash = sha256Hex(credential);
    this.db.prepare(`
      INSERT INTO worker_credentials (worker_id, credential_hash, revoked)
      VALUES (?, ?, 0)
      ON CONFLICT(worker_id) DO UPDATE SET credential_hash = excluded.credential_hash, revoked = 0
    `).run(workerId, hash);
  }

  getCredential(workerId: string): string | undefined {
    const row = this.db.prepare("SELECT credential_hash FROM worker_credentials WHERE worker_id = ?").get(workerId);
    return (row as any)?.credential_hash;
  }

  revokeWorker(workerId: string): void {
    this.db.prepare("UPDATE worker_credentials SET revoked = 1 WHERE worker_id = ?").run(workerId);
  }

  isRevoked(workerId: string): boolean {
    const row = this.db.prepare("SELECT revoked FROM worker_credentials WHERE worker_id = ?").get(workerId);
    return !!row && (row as any).revoked === 1;
  }
}
