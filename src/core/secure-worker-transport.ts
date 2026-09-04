import { WorkerTransport } from "./worker-transport";
import { WorkerSession } from "./worker-session";
import { WorkerSessionStore } from "./worker-session-store";
import { WorkerTransportSecurity } from "./worker-transport-security";
import { WorkerEnrollment } from "./worker-enrollment";
import { InMemoryWorkerAuthStore } from "./worker-auth-store";
import { WorkerAuthentication } from "./worker-authentication";
import { RemoteWorkerStore } from "./remote-worker-store";

export interface PendingJob {
  jobId: string;
  dispatchId: string;
  leaseId: string;
  operation: string;
  payload?: any;
}

export class SecureWorkerTransportServer {
  private pendingJobs = new Map<string, PendingJob[]>();
  private results = new Map<string, any>();
  private security = new WorkerTransportSecurity();
  private auth: WorkerAuthentication;
  private authStore: InMemoryWorkerAuthStore;

  constructor(
    private workerId: string,
    private enrollment: WorkerEnrollment,
    private sessionStore: WorkerSessionStore,
    private workerStore: RemoteWorkerStore
  ) {
    this.authStore = new InMemoryWorkerAuthStore();
    this.auth = new WorkerAuthentication(this.authStore);
  }

  setCredential(workerId: string, credential: string): void {
    this.authStore.setCredential(workerId, credential);
  }

  offerJob(job: PendingJob): void {
    const list = this.pendingJobs.get(this.workerId) || [];
    list.push(job);
    this.pendingJobs.set(this.workerId, list);
  }

  async authenticate(workerId: string, credential: string, sessionId: string): Promise<boolean> {
    // Check worker existence and revoked status in durable store
    const worker = this.workerStore.getWorker(workerId);
    if (!worker) return false;
    if (worker.status === "REVOKED" || worker.status === "OFFLINE") return false;

    const result = this.auth.authenticate({ workerId, credential, timestamp: Date.now() });
    if (!result.authenticated) return false;

    const session: WorkerSession = {
      sessionId,
      workerId,
      status: "ACTIVE",
      createdAt: Date.now(),
      lastSequence: 0,
      expiresAt: Date.now() + 60000,
    };
    this.sessionStore.createSession(session);
    return true;
  }

  receiveResult(workerId: string, sessionId: string, result: any): boolean {
    const session = this.sessionStore.getSession(sessionId);
    if (!session || session.workerId !== workerId || session.status !== "ACTIVE") return false;
    this.results.set(sessionId, result);
    return true;
  }

  getResult(sessionId: string): any {
    return this.results.get(sessionId);
  }

  getJob(workerId: string): PendingJob | null {
    const list = this.pendingJobs.get(workerId);
    if (list && list.length > 0) return list.shift() || null;
    return null;
  }
}

export class SecureWorkerTransportClient implements WorkerTransport {
  private connected = false;
  private authenticated = false;
  private sessionId?: string;

  constructor(
    private workerId: string,
    private credential: string,
    private server: SecureWorkerTransportServer
  ) {}

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async authenticate(workerId: string, credential: string): Promise<boolean> {
    if (workerId !== this.workerId) return false;
    if (credential !== this.credential) return false;
    const sessionId = `session_${workerId}_${Date.now()}`;
    const ok = await this.server.authenticate(workerId, credential, sessionId);
    if (ok) {
      this.authenticated = true;
      this.sessionId = sessionId;
    }
    return ok;
  }

  async heartbeat(workerId: string, currentJobId?: string): Promise<void> {
    if (!this.connected || !this.authenticated) throw new Error("Not authenticated");
  }

  async receiveJob(workerId: string): Promise<any | null> {
    if (!this.connected || !this.authenticated) throw new Error("Not authenticated");
    return this.server.getJob(workerId);
  }

  async reportResult(workerId: string, result: any): Promise<void> {
    if (!this.connected || !this.authenticated || !this.sessionId) throw new Error("Not authenticated");
    const ok = this.server.receiveResult(workerId, this.sessionId, result);
    if (!ok) throw new Error("Result rejected by server");
  }

  async cancelJob(workerId: string, jobId: string): Promise<void> {
    if (!this.connected || !this.authenticated) throw new Error("Not authenticated");
    // server-side cancel would require job ownership validation
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.authenticated = false;
    this.sessionId = undefined;
  }
}
