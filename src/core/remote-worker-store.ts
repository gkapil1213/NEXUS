import Database from "better-sqlite3";
import { RemoteWorker, RemoteWorkerStatus } from "./remote-worker-models";

export class RemoteWorkerStore {
  constructor(private db: Database.Database) {}

  registerWorker(worker: RemoteWorker): void {
    this.db.prepare(`
      INSERT INTO remote_workers (
        worker_id, hostname, platform, architecture, agent_version,
        capabilities, status, registered_at, last_heartbeat_at,
        current_job_id, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      worker.workerId,
      worker.hostname,
      worker.platform,
      worker.architecture,
      worker.agentVersion,
      worker.capabilities ? JSON.stringify(worker.capabilities) : null,
      worker.status,
      worker.registeredAt,
      worker.lastHeartbeatAt,
      worker.currentJobId,
      worker.metadata ? JSON.stringify(worker.metadata) : null
    );
  }

  updateWorker(worker: RemoteWorker): void {
    this.db.prepare(`
      UPDATE remote_workers SET
        hostname = ?,
        platform = ?,
        architecture = ?,
        agent_version = ?,
        capabilities = ?,
        status = ?,
        last_heartbeat_at = ?,
        current_job_id = ?,
        metadata = ?
      WHERE worker_id = ?
    `).run(
      worker.hostname,
      worker.platform,
      worker.architecture,
      worker.agentVersion,
      worker.capabilities ? JSON.stringify(worker.capabilities) : null,
      worker.status,
      worker.lastHeartbeatAt,
      worker.currentJobId,
      worker.metadata ? JSON.stringify(worker.metadata) : null,
      worker.workerId
    );
  }

  getWorker(workerId: string): RemoteWorker | undefined {
    const row = this.db.prepare("SELECT * FROM remote_workers WHERE worker_id = ?").get(workerId);
    return row ? this.mapWorker(row) : undefined;
  }

  listWorkers(): RemoteWorker[] {
    return this.db.prepare("SELECT * FROM remote_workers").all().map(this.mapWorker);
  }

  listWorkersByStatus(status: RemoteWorkerStatus): RemoteWorker[] {
    return this.db.prepare("SELECT * FROM remote_workers WHERE status = ?").all(status).map(this.mapWorker);
  }

  revokeWorker(workerId: string): void {
    this.db.prepare("UPDATE remote_workers SET status = ? WHERE worker_id = ?").run("REVOKED", workerId);
  }

  private mapWorker(row: any): RemoteWorker {
    return {
      workerId: row.worker_id,
      hostname: row.hostname,
      platform: row.platform,
      architecture: row.architecture,
      agentVersion: row.agent_version,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
      status: row.status,
      registeredAt: row.registered_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      currentJobId: row.current_job_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}
