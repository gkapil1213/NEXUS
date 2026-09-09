import { WorkerAuthenticationRequest, WorkerAuthenticationResult } from "./remote-worker-models";


function sha256Hex(input: string): string {
    // Lightweight deterministic hash for credential comparison.
    // Not a cryptographic SHA-256, but sufficient for checkpoint A and browser-safe.
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

function randomToken(): string {
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
        const arr = new Uint8Array(32);
        globalThis.crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
    }
    return `session_${Date.now()}_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function timingSafeEqualStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

export interface WorkerAuthStore {
  getCredential(workerId: string): string | undefined;
  revokeWorker(workerId: string): void;
  isRevoked(workerId: string): boolean;
}

export class WorkerAuthentication {
  constructor(private authStore: WorkerAuthStore, private nonceTtlMs = 60000) {}

  authenticate(request: WorkerAuthenticationRequest): WorkerAuthenticationResult {
    const { workerId, credential, nonce, timestamp } = request;

    if (this.authStore.isRevoked(workerId)) {
      return { authenticated: false, reason: "worker_revoked" };
    }

    const expected = this.authStore.getCredential(workerId);
    if (!expected) {
      return { authenticated: false, reason: "worker_not_found" };
    }

    const providedHash = sha256Hex(credential);
    if (!timingSafeEqualStr(providedHash, expected)) {
      return { authenticated: false, reason: "invalid_credential" };
    }

    if (nonce) {
      if (nonce.length < 8 || nonce.length > 128) {
        return { authenticated: false, reason: "invalid_nonce" };
      }
    }
    if (timestamp) {
      const now = Date.now();
      if (Math.abs(now - timestamp) > this.nonceTtlMs) {
        return { authenticated: false, reason: "expired_timestamp" };
      }
    }

    const sessionToken = randomToken();
    return { authenticated: true, sessionToken };
  }
}
