export type RemoteWorkerStatus =
  | "REGISTERING"
  | "ONLINE"
  | "BUSY"
  | "DRAINING"
  | "OFFLINE"
  | "UNHEALTHY"
  | "REVOKED";

export interface RemoteWorkerCapabilities {
  platforms?: string[];
  architectures?: string[];
  operations?: string[];
  resourceLimits?: Record<string, number>;
}

export interface RemoteWorker {
  workerId: string;
  hostname: string;
  platform?: string;
  architecture?: string;
  agentVersion?: string;
  capabilities?: RemoteWorkerCapabilities;
  status: RemoteWorkerStatus;
  registeredAt: number;
  lastHeartbeatAt?: number;
  currentJobId?: string;
  metadata?: Record<string, any>;
}

export interface WorkerAuthenticationRequest {
  workerId: string;
  credential: string;
  nonce?: string;
  timestamp?: number;
}

export interface WorkerAuthenticationResult {
  authenticated: boolean;
  reason?: string;
  sessionToken?: string;
}
