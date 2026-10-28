import { WorkerAuthStore } from "./worker-authentication";
import { timingSafeEqual } from "./db";
import { randomBytes, pbkdf2Sync } from "crypto";
import { CONFIG } from "./config";

const SALT_BYTES = 16;
const HASH_BYTES = 32;

interface InMemoryCredential {
  salt: string;
  iterations: number;
  hash: string;
}

/**
 * In-memory credential store used only by legacy tests (phase 15/16/17).
 * Stores PBKDF2-SHA256 records — never plaintext — and implements the
 * same verifyCredential contract as SqliteWorkerAuthStore.
 */
export class InMemoryWorkerAuthStore implements WorkerAuthStore {
  private credentials = new Map<string, InMemoryCredential>();
  private revoked = new Set<string>();

  setCredential(workerId: string, credential: string): void {
    const salt = randomBytes(SALT_BYTES).toString("hex");
    const iterations = CONFIG.pbkdf2Iterations;
    const hash = pbkdf2Sync(credential, salt, iterations, HASH_BYTES, "sha256").toString("hex");
    this.credentials.set(workerId, { salt, iterations, hash });
  }

  getCredential(workerId: string): string | undefined {
    const c = this.credentials.get(workerId);
    return c ? c.hash : undefined;
  }

  verifyCredential(workerId: string, credential: string): { valid: boolean; upgraded?: boolean } {
    const c = this.credentials.get(workerId);
    if (!c) return { valid: false };
    if (c.hash.length !== HASH_BYTES * 2) return { valid: false };
    if (!Number.isFinite(c.iterations) || c.iterations < 1) return { valid: false };
    const candidate = pbkdf2Sync(credential, c.salt, c.iterations, HASH_BYTES, "sha256").toString("hex");
    return { valid: timingSafeEqual(candidate, c.hash) };
  }

  revokeWorker(workerId: string): void {
    this.revoked.add(workerId);
  }

  isRevoked(workerId: string): boolean {
    return this.revoked.has(workerId);
  }
}