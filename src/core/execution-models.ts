export type ExecutionJobStatus =
  | "QUEUED"
  | "CLAIMED"
  | "RUNNING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "RETRY_SCHEDULED"
  | "DEAD_LETTER"
  | "CANCELLATION_REQUESTED"
  | "CANCELLED"
  | "ORPHANED"
  | "BLOCKED";

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  retryableErrors?: string[];
}

export interface ExecutionJob {
  id: string;
  idempotencyKey: string;
  jobType: string;
  payload?: any;
  status: ExecutionJobStatus;
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  currentLeaseId?: string;
  cancellationRequested: boolean;
  cancellationAcknowledged: boolean;
}

export type ExecutionAttemptStatus = ExecutionJobStatus;

export interface ExecutionAttempt {
  id: string;
  jobId: string;
  attemptNumber: number;
  status: ExecutionAttemptStatus;
  workerId?: string;
  leaseId?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  evidence?: string[];
  createdAt: number;
}

export type WorkerStatus = "ONLINE" | "BUSY" | "DRAINING" | "OFFLINE" | "LOST";

export interface ExecutionWorker {
  workerId: string;
  hostname?: string;
  capabilities?: string[];
  status: WorkerStatus;
  lastHeartbeatAt?: number;
  currentJobId?: string;
  registeredAt: number;
}

export type LeaseStatus = "ACTIVE" | "EXPIRED" | "RELEASED";

export interface ExecutionLease {
  leaseId: string;
  jobId: string;
  workerId: string;
  acquiredAt: number;
  expiresAt: number;
  renewedAt?: number;
  releasedAt?: number;
  status: LeaseStatus;
}

export interface ArtifactRecord {
  artifactId: string;
  jobId?: string;
  releaseId?: string;
  name: string;
  type: string;
  sizeBytes?: number;
  checksum: string;
  storageRef?: string;
  metadata?: any;
  createdAt: number;
}

export type ReleaseStatus = "CREATED" | "VALIDATING" | "APPROVED" | "BLOCKED" | "DEPLOYING" | "DEPLOYED" | "FAILED" | "ROLLED_BACK";

export interface ReleaseRecord {
  releaseId: string;
  version: string;
  buildInfo?: any;
  artifactId?: string;
  status: ReleaseStatus;
  createdAt: number;
  updatedAt: number;
}

export type DeploymentStatus =
  | "PREPARING"
  | "GATE_CHECKING"
  | "APPROVAL_REQUIRED"
  | "APPROVED"
  | "DEPLOYING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "INTERVENTION_REQUIRED";

export interface DeploymentRecord {
  deploymentId: string;
  releaseId: string;
  environment: string;
  status: DeploymentStatus;
  createdAt: number;
  updatedAt: number;
  rollbackDeploymentId?: string;
  evidence?: string[];
}

export interface ApprovalRequest {
  approvalId: string;
  deploymentId: string;
  releaseId: string;
  environment: string;
  requestedAction: string;
  decision: "AUTOMATIC" | "HUMAN_APPROVAL_REQUIRED" | "DENIED" | "BLOCKED";
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
  createdAt: number;
}

export interface ExecutionEvent {
  eventId: string;
  jobId?: string;
  deploymentId?: string;
  eventType: string;
  payload?: any;
  createdAt: number;
}
