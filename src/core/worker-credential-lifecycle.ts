import Database from "better-sqlite3";
import { WorkerCredentialService } from "./worker-credentials";
import { WorkerSessionStore } from "./worker-session-store";
import { WorkerTrustStore } from "./worker-trust";
import { WorkerSecurityEventStore } from "./worker-security-events";
import { RemoteWorkerStore } from "./remote-worker-store";

export class WorkerCredentialLifecycleManager {
  constructor(
    private db: Database.Database,
    private credentials: WorkerCredentialService,
    private sessions: WorkerSessionStore,
    private trust: WorkerTrustStore,
    private securityEvents: WorkerSecurityEventStore,
    private workers: RemoteWorkerStore
  ) {}

  rotateCredential(workerId: string, graceMs: number = 0): { credentialId: string; secret: string; version: number } {
    // Prevent rotation if worker revoked
    const trustRecord = this.trust.getTrust(workerId);
    if (trustRecord && trustRecord.trustState === "REVOKED") {
      throw new Error("Worker is revoked; rotation not allowed");
    }
    const result = this.credentials.rotateCredential(workerId, graceMs);
    this.securityEvents.recordEvent({
      eventId: `ce_${result.credentialId}`,
      workerId,
      eventType: "CREDENTIAL_ROTATED",
      severity: "LOW",
      reason: "manual_rotation",
      createdAt: Date.now(),
    });
    return { credentialId: result.credentialId, secret: result.secret, version: result.version };
  }

  revokeCredential(credentialId: string, reason: string): void {
    const credential = this.credentials.getCredential(credentialId);
    if (!credential) throw new Error("Credential not found");
    this.credentials.revokeCredential(credentialId, reason);
    this.sessions.revokeAllForWorker(credential.workerId);
    this.securityEvents.recordEvent({
      eventId: `rev_${credentialId}_${Date.now()}`,
      workerId: credential.workerId,
      eventType: "CREDENTIAL_REVOKED",
      severity: "HIGH",
      reason,
      createdAt: Date.now(),
    });
    if (reason === "compromised" || reason === "suspicious_activity") {
      this.trust.transitionWorker(credential.workerId, "QUARANTINED", "CRITICAL", reason);
    }
  }

  reEnrollWorker(workerId: string): { credentialId: string; secret: string; version: number } {
    // Revoke all active credentials for zero-trust re-enrollment
    const activeCredentials = this.getActiveCredentials(workerId);
    for (const cred of activeCredentials) {
      this.credentials.revokeCredential(cred.credentialId, "re_enrollment");
    }
    this.sessions.revokeAllForWorker(workerId);
    const { credentialId, secret, version } = this.credentials.createCredential(workerId, undefined, "ACTIVE");
    this.trust.transitionWorker(workerId, "ENROLLING", "LOW", "re_enrollment");
    this.securityEvents.recordEvent({
      eventId: `reenroll_${credentialId}`,
      workerId,
      eventType: "SUCCESSFUL_REENROLLMENT",
      severity: "MEDIUM",
      reason: "zero_trust_re_enrollment",
      createdAt: Date.now(),
    });
    return { credentialId, secret, version };
  }

  private getActiveCredentials(workerId: string): { credentialId: string }[] {
    const rows = this.db.prepare(`
      SELECT * FROM worker_credential_lifecycle
      WHERE worker_id = ? AND status IN ('ACTIVE','ROTATION_REQUIRED','ROTATING')
    `).all(workerId) as any[];
    return rows.map((row) => ({ credentialId: row.credential_id }));
  }
}
