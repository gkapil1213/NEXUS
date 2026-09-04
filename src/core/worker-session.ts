export type WorkerSessionStatus =
  | "CREATED"
  | "AUTHENTICATING"
  | "ACTIVE"
  | "IDLE"
  | "BUSY"
  | "DRAINING"
  | "EXPIRED"
  | "REVOKED"
  | "DISCONNECTED";

export interface WorkerSession {
  sessionId: string;
  workerId: string;
  status: WorkerSessionStatus;
  protocolVersion?: string;
  connectionId?: string;
  createdAt: number;
  authenticatedAt?: number;
  lastSeenAt?: number;
  lastHeartbeatAt?: number;
  lastSequence: number;
  expiresAt: number;
  revoked?: boolean;
  metadata?: Record<string, any>;
}
