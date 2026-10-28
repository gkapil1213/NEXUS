import { WorkerAuthenticationRequest, WorkerAuthenticationResult } from "./remote-worker-models";
import { NexusEngine } from "./db";

/**
 * Generate a session token from cryptographic randomness.
 * Fails closed — never falls back to Math.random().
 */
function secureRandomToken(): string {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.getRandomValues) {
    throw new Error("secure_random_unavailable");
  }
  const arr = new Uint8Array(32);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

const NONCE_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

export interface WorkerAuthStore {
  getCredential(workerId: string): string | undefined;
  revokeWorker(workerId: string): void;
  isRevoked(workerId: string): boolean;
  /**
   * Verify a credential against the stored hash. Implementations must
   * use constant-time comparison and must handle both legacy and
   * current hash formats. Migration happens inside this call.
   */
  verifyCredential(workerId: string, credential: string): { valid: boolean; upgraded?: boolean };
}

export class WorkerAuthentication {
  constructor(
    private authStore: WorkerAuthStore,
    private authWindowMs = 5 * 60 * 1000,
    private db?: NexusEngine,
  ) {
    if (this.db) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS worker_auth_nonces (
          worker_id TEXT NOT NULL,
          nonce TEXT NOT NULL,
          seen_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (worker_id, nonce)
        );
      `);
    }
  }

  authenticate(request: WorkerAuthenticationRequest): WorkerAuthenticationResult {
    const { workerId, credential, nonce, timestamp } = request;

    // 1. Presence + format of all required fields.
    if (!workerId || typeof workerId !== "string") {
      return { authenticated: false, reason: "missing_worker_id" };
    }
    if (!credential || typeof credential !== "string") {
      return { authenticated: false, reason: "missing_credential" };
    }
    if (timestamp === undefined || !Number.isFinite(timestamp)) {
      return { authenticated: false, reason: "missing_timestamp" };
    }
    if (!nonce || typeof nonce !== "string") {
      return { authenticated: false, reason: "missing_nonce" };
    }
    if (!NONCE_FORMAT.test(nonce)) {
      return { authenticated: false, reason: "invalid_nonce" };
    }

    // 2. Timestamp freshness — bidirectional clock-skew window.
    const now = Date.now();
    const skew = Math.abs(now - timestamp);
    if (skew > this.authWindowMs) {
      return {
        authenticated: false,
        reason: timestamp < now ? "expired_timestamp" : "future_timestamp",
      };
    }

    // 3. Revocation.
    if (this.authStore.isRevoked(workerId)) {
      return { authenticated: false, reason: "worker_revoked" };
    }

    // 4. Credential verification — no fallback. A store that cannot
    //    verify securely refuses authentication entirely.
    if (typeof this.authStore.verifyCredential !== "function") {
      return { authenticated: false, reason: "insecure_auth_store" };
    }
    const verification = this.authStore.verifyCredential(workerId, credential);
    if (!verification.valid) {
      const stored = this.authStore.getCredential(workerId);
      return {
        authenticated: false,
        reason: stored ? "invalid_credential" : "worker_not_found",
      };
    }

    // 5. Nonce replay protection — mandatory and durable.
    if (!this.db) {
      return { authenticated: false, reason: "nonce_store_unavailable" };
    }
    const nonceNow = Date.now();
    this.db.prepare("DELETE FROM worker_auth_nonces WHERE expires_at <= ?").run(nonceNow);
    try {
      this.db.prepare(
        "INSERT INTO worker_auth_nonces (worker_id, nonce, seen_at, expires_at) VALUES (?, ?, ?, ?)"
      ).run(workerId, nonce, nonceNow, nonceNow + this.authWindowMs);
    } catch {
      return { authenticated: false, reason: "replayed_nonce" };
    }

    // 6. Session token — cryptographic only.
    let sessionToken: string;
    try {
      sessionToken = secureRandomToken();
    } catch {
      return { authenticated: false, reason: "secure_random_unavailable" };
    }
    return { authenticated: true, sessionToken };
  }
}