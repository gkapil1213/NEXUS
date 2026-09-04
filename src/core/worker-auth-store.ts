import { WorkerAuthStore } from "./worker-authentication";

export class InMemoryWorkerAuthStore implements WorkerAuthStore {
  private credentials = new Map<string, string>();
  private revoked = new Set<string>();

  setCredential(workerId: string, credential: string): void {
    this.credentials.set(workerId, credential);
  }

  getCredential(workerId: string): string | undefined {
    return this.credentials.get(workerId);
  }

  revokeWorker(workerId: string): void {
    this.revoked.add(workerId);
  }

  isRevoked(workerId: string): boolean {
    return this.revoked.has(workerId);
  }
}
