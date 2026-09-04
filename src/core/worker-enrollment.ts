import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { RemoteWorkerStore } from "./remote-worker-store";
import { RemoteWorkerStatus } from "./remote-worker-models";
import { CredentialResolver } from "./credential-resolver";

export type EnrollmentStatus = "CREATED" | "CONSUMED" | "EXPIRED" | "REVOKED";

export interface EnrollmentRecord {
  enrollmentId: string;
  workerId: string;
  tokenHash: string;
  status: EnrollmentStatus;
  capabilities?: string[];
  metadata?: Record<string, any>;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  revokedAt?: number;
}

export interface EnrollmentCreationResult {
  enrollmentId: string;
  token: string;
  expiresAt: number;
}

export interface BootstrapConfig {
  workerId: string;
  enrollmentId: string;
  controlPlaneUrl: string;
  protocol: string;
  version: string;
  heartbeatIntervalMs: number;
  capabilities: string[];
  security: {
    transport: string;
    credentialRef: string;
  };
  token: string;
}

export interface AuditEvent {
  eventType: string;
  workerId: string;
  enrollmentId: string;
  timestamp: number;
  reason?: string;
}

export class WorkerEnrollment {
  private auditEvents: AuditEvent[] = [];

  constructor(
    private db: Database.Database,
    private workerStore: RemoteWorkerStore,
    private credentialResolver: CredentialResolver
  ) {}

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private emitAudit(eventType: string, workerId: string, enrollmentId: string, reason?: string): void {
    this.auditEvents.push({
      eventType,
      workerId,
      enrollmentId,
      timestamp: Date.now(),
      reason,
    });
  }

  getAuditEvents(): AuditEvent[] {
    return this.auditEvents;
  }

  createEnrollment(workerId: string, capabilities: string[] = [], ttlMs: number = 3600000, metadata?: Record<string, any>): EnrollmentCreationResult {
    // Ensure worker identity exists; create if necessary
    let worker = this.workerStore.getWorker(workerId);
    if (!worker) {
      worker = {
        workerId,
        hostname: workerId,
        status: "REGISTERING" as RemoteWorkerStatus,
        capabilities: { operations: capabilities },
        registeredAt: Date.now(),
      };
      this.workerStore.registerWorker(worker);
    }

    // Check duplicate enrollment: worker already has a non-expired active enrollment?
    const existing = this.db.prepare(
      "SELECT * FROM worker_enrollments WHERE worker_id = ? AND status = 'CREATED' AND expires_at > ?"
    ).get(workerId, Date.now());
    if (existing) {
      throw new Error(`Worker ${workerId} already has an active enrollment`);
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.hashToken(token);
    const enrollmentId = `enroll_${randomBytes(8).toString("hex")}`;
    const now = Date.now();
    const expiresAt = now + ttlMs;

    this.db.prepare(`
      INSERT INTO worker_enrollments (
        enrollment_id, worker_id, token_hash, status, capabilities, metadata,
        created_at, expires_at, consumed_at, revoked_at
      ) VALUES (?, ?, ?, 'CREATED', ?, ?, ?, ?, NULL, NULL)
    `).run(
      enrollmentId,
      workerId,
      tokenHash,
      capabilities ? JSON.stringify(capabilities) : null,
      metadata ? JSON.stringify(metadata) : null,
      now,
      expiresAt
    );

    this.emitAudit("ENROLLMENT_CREATED", workerId, enrollmentId);
    return { enrollmentId, token, expiresAt };
  }

  validateEnrollment(enrollmentId: string, token: string, workerId: string): { valid: boolean; reason?: string } {
    const row = this.getEnrollment(enrollmentId);
    if (!row) {
      this.emitAudit("ENROLLMENT_REJECTED", workerId, enrollmentId, "not_found");
      return { valid: false, reason: "enrollment_not_found" };
    }

    if (row.workerId !== workerId) {
      this.emitAudit("ENROLLMENT_REJECTED", workerId, enrollmentId, "worker_mismatch");
      return { valid: false, reason: "worker_mismatch" };
    }

    if (row.status !== "CREATED") {
      this.emitAudit("ENROLLMENT_REJECTED", workerId, enrollmentId, `status_${row.status}`);
      return { valid: false, reason: `status_${row.status}` };
    }

    if (Date.now() > row.expiresAt) {
      this.expireEnrollment(enrollmentId);
      this.emitAudit("ENROLLMENT_EXPIRED", workerId, enrollmentId);
      return { valid: false, reason: "expired" };
    }

    const tokenHash = this.hashToken(token);
    if (tokenHash !== row.tokenHash) {
      this.emitAudit("ENROLLMENT_REJECTED", workerId, enrollmentId, "invalid_token");
      return { valid: false, reason: "invalid_token" };
    }

    return { valid: true };
  }

  consumeEnrollment(enrollmentId: string, token: string, workerId: string): { success: boolean; reason?: string } {
    const validation = this.validateEnrollment(enrollmentId, token, workerId);
    if (!validation.valid) {
      return { success: false, reason: validation.reason };
    }

    this.db.prepare(`
      UPDATE worker_enrollments SET status = 'CONSUMED', consumed_at = ? WHERE enrollment_id = ?
    `).run(Date.now(), enrollmentId);

    this.emitAudit("ENROLLMENT_CONSUMED", workerId, enrollmentId);
    return { success: true };
  }

  revokeEnrollment(enrollmentId: string, reason?: string): void {
    this.db.prepare(`
      UPDATE worker_enrollments SET status = 'REVOKED', revoked_at = ? WHERE enrollment_id = ?
    `).run(Date.now(), enrollmentId);
    const row = this.getEnrollment(enrollmentId);
    if (row) this.emitAudit("ENROLLMENT_REVOKED", row.workerId, enrollmentId, reason);
  }

  expireEnrollment(enrollmentId: string): void {
    this.db.prepare(`
      UPDATE worker_enrollments SET status = 'EXPIRED' WHERE enrollment_id = ? AND status = 'CREATED'
    `).run(enrollmentId);
    const row = this.getEnrollment(enrollmentId);
    if (row) this.emitAudit("ENROLLMENT_EXPIRED", row.workerId, enrollmentId);
  }

  getEnrollment(enrollmentId: string): EnrollmentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM worker_enrollments WHERE enrollment_id = ?").get(enrollmentId);
    return row ? this.mapEnrollment(row) : undefined;
  }

  generateBootstrap(enrollmentId: string, token: string, controlPlaneUrl: string, heartbeatIntervalMs: number = 30000): BootstrapConfig {
    const enrollment = this.getEnrollment(enrollmentId);
    if (!enrollment) throw new Error("Enrollment not found");
    const worker = this.workerStore.getWorker(enrollment.workerId);
    if (!worker) throw new Error("Worker not found");
    return {
      workerId: enrollment.workerId,
      enrollmentId,
      controlPlaneUrl,
      protocol: "https",
      version: "1.0",
      heartbeatIntervalMs,
      capabilities: enrollment.capabilities || [],
      security: {
        transport: "https",
        credentialRef: enrollment.enrollmentId,
      },
      token,
    };
  }

  private mapEnrollment(row: any): EnrollmentRecord {
    return {
      enrollmentId: row.enrollment_id,
      workerId: row.worker_id,
      tokenHash: row.token_hash,
      status: row.status,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      revokedAt: row.revoked_at,
    };
  }
}
