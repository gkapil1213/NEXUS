import { WorkerAuthenticationRequest, WorkerAuthenticationResult } from "./remote-worker-models";

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

    const a = Buffer.from(credential);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !a.equals(b)) {
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

    const sessionToken = `session_${workerId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return { authenticated: true, sessionToken };
  }
}
