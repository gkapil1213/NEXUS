import { WorkerAuthStore } from "./worker-authentication";
import { NexusEngine, timingSafeEqual } from "./db";
import { randomBytes, pbkdf2Sync } from "crypto";
import { CONFIG } from "./config";

const ALGORITHM = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BYTES = 32;

// Legacy 32-bit polynomial hash — ONLY for verifying pre-migration rows.
function legacyHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

interface CredentialRow {
  credential_hash: string;
  algorithm: string | null;
  salt: string | null;
  iterations: number | null;
  revoked: number;
}

export class SqliteWorkerAuthStore implements WorkerAuthStore {
  constructor(private db: NexusEngine) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_auth_credentials (
        worker_id TEXT PRIMARY KEY,
        credential_hash TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.ensureColumn("algorithm", "TEXT");
    this.ensureColumn("salt", "TEXT");
    this.ensureColumn("iterations", "INTEGER");
  }

  private ensureColumn(name: string, type: string): void {
    try {
      this.db.exec(`ALTER TABLE worker_auth_credentials ADD COLUMN ${name} ${type}`);
    } catch {
      // Column already exists.
    }
  }

  setCredential(workerId: string, credential: string): void {
    const salt = randomBytes(SALT_BYTES).toString("hex");
    const iterations = CONFIG.pbkdf2Iterations;
    const hash = pbkdf2Sync(credential, salt, iterations, HASH_BYTES, "sha256").toString("hex");
    this.db.prepare(`
      INSERT INTO worker_auth_credentials (worker_id, credential_hash, algorithm, salt, iterations, revoked)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(worker_id) DO UPDATE SET
        credential_hash = excluded.credential_hash,
        algorithm = excluded.algorithm,
        salt = excluded.salt,
        iterations = excluded.iterations,
        revoked = 0
    `).run(workerId, hash, ALGORITHM, salt, iterations);
  }

  setLegacyCredential(workerId: string, credential: string): void {
    const hash = legacyHash(credential);
    this.db.prepare(`
      INSERT INTO worker_auth_credentials (worker_id, credential_hash, revoked)
      VALUES (?, ?, 0)
      ON CONFLICT(worker_id) DO UPDATE SET credential_hash = excluded.credential_hash, revoked = 0
    `).run(workerId, hash);
  }

  getCredential(workerId: string): string | undefined {
    const row = this.db.prepare("SELECT credential_hash FROM worker_auth_credentials WHERE worker_id = ?").get(workerId);
    return (row as any)?.credential_hash;
  }

  verifyCredential(workerId: string, credential: string): { valid: boolean; upgraded?: boolean } {
    const row = this.db.prepare(
      "SELECT credential_hash, algorithm, salt, iterations, revoked FROM worker_auth_credentials WHERE worker_id = ?"
    ).get(workerId) as CredentialRow | undefined;
    if (!row || row.revoked) return { valid: false };

    if (row.algorithm === ALGORITHM) {
      if (!row.salt || typeof row.salt !== "string" || row.salt.length === 0) return { valid: false };
      if (!row.iterations || !Number.isFinite(row.iterations) || row.iterations < 1) return { valid: false };
      if (typeof row.credential_hash !== "string" || row.credential_hash.length !== HASH_BYTES * 2) return { valid: false };
      const candidate = pbkdf2Sync(credential, row.salt, row.iterations, HASH_BYTES, "sha256").toString("hex");
      return { valid: timingSafeEqual(candidate, row.credential_hash) };
    }

    if (typeof row.credential_hash !== "string" || row.credential_hash.length !== 64) return { valid: false };
    if (timingSafeEqual(legacyHash(credential), row.credential_hash)) {
      this.setCredential(workerId, credential);
      return { valid: true, upgraded: true };
    }
    return { valid: false };
  }

  revokeWorker(workerId: string): void {
    this.db.prepare("UPDATE worker_auth_credentials SET revoked = 1 WHERE worker_id = ?").run(workerId);
  }

  isRevoked(workerId: string): boolean {
    const row = this.db.prepare("SELECT revoked FROM worker_auth_credentials WHERE worker_id = ?").get(workerId);
    return !!row && (row as any).revoked === 1;
  }
}