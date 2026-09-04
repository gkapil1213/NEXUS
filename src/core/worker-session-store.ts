import Database from "better-sqlite3";
import { WorkerSession, WorkerSessionStatus } from "./worker-session";

export class WorkerSessionStore {
  constructor(private db: Database.Database) {}

  createSession(session: WorkerSession): void {
    this.db.prepare(`
      INSERT INTO worker_sessions (
        session_id, worker_id, status, protocol_version, connection_id,
        created_at, authenticated_at, last_seen_at, last_heartbeat_at,
        last_sequence, expires_at, revoked, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.sessionId,
      session.workerId,
      session.status,
      session.protocolVersion,
      session.connectionId,
      session.createdAt,
      session.authenticatedAt,
      session.lastSeenAt,
      session.lastHeartbeatAt,
      session.lastSequence,
      session.expiresAt,
      session.revoked ? 1 : 0,
      session.metadata ? JSON.stringify(session.metadata) : null
    );
  }

  updateSession(session: WorkerSession): void {
    this.db.prepare(`
      UPDATE worker_sessions SET
        status = ?,
        protocol_version = ?,
        connection_id = ?,
        authenticated_at = ?,
        last_seen_at = ?,
        last_heartbeat_at = ?,
        last_sequence = ?,
        expires_at = ?,
        revoked = ?,
        metadata = ?
      WHERE session_id = ?
    `).run(
      session.status,
      session.protocolVersion,
      session.connectionId,
      session.authenticatedAt,
      session.lastSeenAt,
      session.lastHeartbeatAt,
      session.lastSequence,
      session.expiresAt,
      session.revoked ? 1 : 0,
      session.metadata ? JSON.stringify(session.metadata) : null,
      session.sessionId
    );
  }

  getSession(sessionId: string): WorkerSession | undefined {
    const row = this.db.prepare("SELECT * FROM worker_sessions WHERE session_id = ?").get(sessionId);
    return row ? this.mapSession(row) : undefined;
  }

  getActiveSessionForWorker(workerId: string): WorkerSession | undefined {
    const row = this.db.prepare(
      "SELECT * FROM worker_sessions WHERE worker_id = ? AND status IN ('ACTIVE','BUSY','IDLE') ORDER BY created_at DESC LIMIT 1"
    ).get(workerId);
    return row ? this.mapSession(row) : undefined;
  }

  markRevoked(sessionId: string): void {
    this.db.prepare("UPDATE worker_sessions SET status = 'REVOKED', revoked = 1 WHERE session_id = ?").run(sessionId);
  }

  revokeAllForWorker(workerId: string): void {
    this.db.prepare("UPDATE worker_sessions SET status = 'REVOKED', revoked = 1 WHERE worker_id = ?").run(workerId);
  }

  private mapSession(row: any): WorkerSession {
    return {
      sessionId: row.session_id,
      workerId: row.worker_id,
      status: row.status,
      protocolVersion: row.protocol_version,
      connectionId: row.connection_id,
      createdAt: row.created_at,
      authenticatedAt: row.authenticated_at,
      lastSeenAt: row.last_seen_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastSequence: row.last_sequence,
      expiresAt: row.expires_at,
      revoked: !!row.revoked,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}
