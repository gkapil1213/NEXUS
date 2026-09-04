import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";

export interface WorkerCredential {
  credentialId: string;
  workerId: string;
  credentialHash: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
}

export class WorkerCredentialManager {
  constructor(private db: Database.Database) {}

  generateCredential(workerId: string, ttlMs?: number): { credentialId: string; secret: string; expiresAt?: number } {
    const secret = randomBytes(32).toString("base64url");
    const credentialHash = createHash("sha256").update(secret).digest("hex");
    const credentialId = `cred_${randomBytes(8).toString("hex")}`;
    const now = Date.now();
    const expiresAt = ttlMs ? now + ttlMs : undefined;

    this.db.prepare(`
      INSERT INTO worker_credentials (credential_id, worker_id, credential_hash, status, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, 'ACTIVE', ?, NULL, ?)
    `).run(credentialId, workerId, credentialHash, expiresAt, now);

    return { credentialId, secret, expiresAt };
  }

  verifyCredential(credentialId: string, secret: string): boolean {
    const row = this.db.prepare("SELECT * FROM worker_credentials WHERE credential_id = ?").get(credentialId) as any;
    if (!row) return false;
    if (row.status !== "ACTIVE") return false;
    if (row.expires_at && Date.now() > row.expires_at) {
      this.db.prepare("UPDATE worker_credentials SET status = 'EXPIRED' WHERE credential_id = ?").run(credentialId);
      return false;
    }
    const actualHash = createHash("sha256").update(secret).digest("hex");
    const a = Buffer.from(actualHash);
    const b = Buffer.from(row.credential_hash);
    return a.length === b.length && a.equals(b);
  }

  revokeCredential(credentialId: string): void {
    this.db.prepare("UPDATE worker_credentials SET status = 'REVOKED', revoked_at = ? WHERE credential_id = ?").run(Date.now(), credentialId);
  }
}
