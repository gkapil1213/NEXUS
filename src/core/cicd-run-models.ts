export type CICDRunStatus =
  | "CREATED"
  | "QUEUED"
  | "RUNNING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "AUTH_FAILED"
  | "UNAVAILABLE"
  | "ROLLING_BACK"
  | "ROLLED_BACK";

export interface CICDRunRecord {
  runId: string;
  providerId: string;
  externalRunId?: string;
  jobId?: string;
  repository?: string;
  ref?: string;
  status: CICDRunStatus;
  createdAt: number;
  updatedAt: number;
  evidence?: any;
}
