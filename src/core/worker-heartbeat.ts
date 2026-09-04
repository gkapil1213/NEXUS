import Database from "better-sqlite3";
import { WorkerHealthStore } from "./worker-health";
import { WorkerSessionStore } from "./worker-session-store";
import { RemoteWorkerStore } from "./remote-worker-store";

export interface HeartbeatMessage {
  messageId: string;
  workerId: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  currentJobId?: string;
  currentLeaseId?: string;
}

export class WorkerHeartbeatService {
  constructor(
    private db: Database.Database,
    private workerStore: RemoteWorkerStore,
    private sessionStore: WorkerSessionStore,
    private healthStore: WorkerHealthStore
  ) {}

  processHeartbeat(msg: HeartbeatMessage): { accepted: boolean; reason?: string } {
    const worker = this.workerStore.getWorker(msg.workerId);
    if (!worker) return { accepted: false, reason: "worker_not_found" };
    if (worker.status === "REVOKED") return { accepted: false, reason: "worker_revoked" };

    const session = this.sessionStore.getSession(msg.sessionId);
    if (!session || session.workerId !== msg.workerId) return { accepted: false, reason: "invalid_session" };
    if (session.status !== "ACTIVE" && session.status !== "BUSY" && session.status !== "IDLE") {
      return { accepted: false, reason: "session_not_active" };
    }
    if (msg.sequence <= session.lastSequence) return { accepted: false, reason: "invalid_sequence" };

    const now = Date.now();
    session.lastSequence = msg.sequence;
    session.lastHeartbeatAt = now;
    session.lastSeenAt = now;
    this.sessionStore.updateSession(session);

    worker.lastHeartbeatAt = now;
    if (msg.currentJobId) {
      worker.currentJobId = msg.currentJobId;
      worker.status = "BUSY";
    } else if (worker.status === "BUSY") {
      worker.status = "ONLINE";
    }
    this.workerStore.updateWorker(worker);

    const health = this.healthStore.getHealth(msg.workerId);
    const heartbeatFailures = health ? 0 : 0;
    this.healthStore.upsertHealth({
      workerId: msg.workerId,
      healthState: "HEALTHY",
      lastHeartbeatAt: now,
      heartbeatFailures,
      lastJobId: msg.currentJobId,
      lastLeaseId: msg.currentLeaseId,
      detectedAt: undefined,
      updatedAt: now,
    });

    this.healthStore.recordHealthEvent({
      eventId: `hbe_${msg.messageId}`,
      workerId: msg.workerId,
      eventType: "HEARTBEAT_RECEIVED",
      payload: { sequence: msg.sequence },
      createdAt: now,
    });

    return { accepted: true };
  }
}
