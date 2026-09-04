import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";

export type CredentialStatus =
  | "PENDING"
  | "ACTIVE"
  | "ROTATION_REQUIRED"
  | "ROTATING"
  | "REVOKED"
  | "COMPROMISED"
  | "EXPIRED";

export interface WorkerCredentialRecord {
  credentialId: string;
  workerId: string;
  credentialVersion: number;
  credentialHash: string;
  status: CredentialStatus;
  previousCredentialId?: string;
  replacementCredentialId?: string;
  createdAt: number;
  activatedAt?: number;
  expiresAt?: number;
  rotatedAt?: number;
  revokedAt?: number;
  revocationReason?: string;
  lastUsedAt?: number;
  metadata?: Record<string, any>;
}

export class WorkerCredentialService {
  constructor(private db: Database.Database) {}

  private hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
  }

  private generateId(): string {
    return `cred_${randomBytes(12).toString("hex")}`;
  }

  createCredential(workerId: string, ttlMs?: number, initialStatus: CredentialStatus = "PENDING"): { credentialId: string; secret: string; version: number; expiresAt?: number } {
    const latest = this.getLatestCredential(workerId);
    const version = latest ? latest.credentialVersion + 1 : 1;
    const secret = randomBytes(32).toString("base64url");
    const credentialId = this.generateId();
    const now = Date.now();
    const expiresAt = ttlMs ? now + ttlMs : undefined;
    this.db.prepare(`
      INSERT INTO worker_credential_lifecycle (
        credential_id, worker_id, credential_version, credential_hash, status,
        created_at, expires_at, activated_at, previous_credential_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      credentialId,
      workerId,
      version,
      this.hashSecret(secret),
      initialStatus,
      now,
      expiresAt,
      initialStatus === "ACTIVE" ? now : null,
      latest ? latest.credentialId : null
    );
    return { credentialId, secret, version, expiresAt };
  }

  activateCredential(credentialId: string): void {
    this.db.prepare(`
      UPDATE worker_credential_lifecycle SET status = 'ACTIVE', activated_at = ? WHERE credential_id = ? AND status = 'PENDING'
    `).run(Date.now(), credentialId);
  }

  verifyCredential(workerId: string, secret: string): { valid: boolean; credentialId?: string; version?: number; reason?: string } {
    const worker = this.db.prepare("SELECT status FROM remote_workers WHERE worker_id = ?").get(workerId) as any;
    if (!worker || worker.status === "REVOKED") return { valid: false, reason: "worker_revoked" };

    const rows = this.db.prepare(`
      SELECT * FROM worker_credential_lifecycle
      WHERE worker_id = ? AND status IN ('ACTIVE','ROTATION_REQUIRED','ROTATING')
      ORDER BY credential_version DESC
    `).all(workerId) as any[];
    if (rows.length === 0) return { valid: false, reason: "no_active_credential" };

    const hash = this.hashSecret(secret);
    for (const row of rows) {
      if (row.expires_at && Date.now() > row.expires_at) {
        this.db.prepare("UPDATE worker_credential_lifecycle SET status = 'EXPIRED' WHERE credential_id = ?").run(row.credential_id);
        continue;
      }
      const a = Buffer.from(hash);
      const b = Buffer.from(row.credential_hash);
      if (a.length === b.length && a.equals(b)) {
        this.db.prepare("UPDATE worker_credential_lifecycle SET last_used_at = ? WHERE credential_id = ?").run(Date.now(), row.credential_id);
        return { valid: true, credentialId: row.credential_id, version: row.credential_version };
      }
    }
    return { valid: false, reason: "invalid_secret" };
  }

  getLatestCredential(workerId: string): WorkerCredentialRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM worker_credential_lifecycle WHERE worker_id = ? ORDER BY credential_version DESC LIMIT 1
    `).get(workerId);
    return row ? this.mapRecord(row) : undefined;
  }

  getCredential(credentialId: string): WorkerCredentialRecord | undefined {
    const row = this.db.prepare("SELECT * FROM worker_credential_lifecycle WHERE credential_id = ?").get(credentialId);
    return row ? this.mapRecord(row) : undefined;
  }

  revokeCredential(credentialId: string, reason: string = "manual"): void {
    this.db.prepare(`
      UPDATE worker_credential_lifecycle SET status = 'REVOKED', revoked_at = ?, revocation_reason = ? WHERE credential_id = ?
    `).run(Date.now(), reason, credentialId);
  }

  rotateCredential(workerId: string, graceMs: number = 0): { credentialId: string; secret: string; version: number; previousCredentialId: string } {
    const latest = this.getLatestCredential(workerId);
    if (!latest || latest.status !== "ACTIVE") throw new Error("No active credential to rotate");
    const { credentialId, secret, version } = this.createCredential(workerId, undefined, "ACTIVE");
    const previousId = latest.credentialId;
    // Update old credential to ROTATION_REQUIRED (or REVOKED if grace=0)
    const oldStatus = graceMs > 0 ? "ROTATION_REQUIRED" : "REVOKED";
    this.db.prepare(`
      UPDATE worker_credential_lifecycle SET status = ?, rotated_at = ?, replacement_credential_id = ? WHERE credential_id = ?
    `).run(oldStatus, Date.now(), credentialId, previousId);
    if (graceMs === 0) {
      this.db.prepare(`UPDATE worker_credential_lifecycle SET revoked_at = ?, revocation_reason = 'rotation_immediate' WHERE credential_id = ?`).run(Date.now(), previousId);
    }
    // Update new credential previous link
    this.db.prepare(`UPDATE worker_credential_lifecycle SET previous_credential_id = ? WHERE credential_id = ?`).run(previousId, credentialId);
    return { credentialId, secret, version, previousCredentialId: previousId };
  }

  expireGrace(workerId: string): void {
    this.db.prepare(`
      UPDATE worker_credential_lifecycle SET status = 'REVOKED', revoked_at = ?, revocation_reason = 'grace_expired'
      WHERE worker_id = ? AND status = 'ROTATION_REQUIRED'
    `).run(Date.now(), workerId);
  }

  private mapRecord(row: any): WorkerCredentialRecord {
    return {
      credentialId: row.credential_id,
      workerId: row.worker_id,
      credentialVersion: row.credential_version,
      credentialHash: row.credential_hash,
      status: row.status,
      previousCredentialId: row.previous_credential_id,
      replacementCredentialId: row.replacement_credential_id,
      createdAt: row.created_at,
      activatedAt: row.activated_at,
      expiresAt: row.expires_at,
      rotatedAt: row.rotated_at,
      revokedAt: row.revoked_at,
      revocationReason: row.revocation_reason,
      lastUsedAt: row.last_used_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}
