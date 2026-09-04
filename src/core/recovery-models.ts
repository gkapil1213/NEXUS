// src/core/recovery-models.ts

export type RecoveryDecision = "AUTOMATIC" | "HUMAN_APPROVAL_REQUIRED" | "DENIED" | "BLOCKED";

export interface RecoveryAction {
  id: string;
  type: "restart" | "rollback" | "retry" | "scale" | "noop";
  service: string;
  environment: string;
  description: string;
}

export interface RecoveryPolicy {
  id: string;
  name: string;
  targetType: string;          // e.g., "service", "database"
  conditions: Record<string, any>;
  actions: RecoveryAction[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RecoveryJob {
  id: string;
  policyId: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: any;
}

// Minimal definition for IncidentAnalysis (used by RecoveryAgent)
export interface IncidentAnalysis {
  incidentId: string;
  service: string;
  environment: string;
  severity: string;
  details: string;
}
// Append to existing file or integrate cleanly

export type RecoveryLifecycleState =
  | "DETECTED"
  | "ANALYZING"
  | "DECIDING"
  | "APPROVED"
  | "EXECUTING"
  | "VERIFYING"
  | "RECOVERED"
  | "FAILED"
  | "BLOCKED"
  | "HUMAN_REVIEW_REQUIRED";

export interface RecoveryAttemptRecord {
  id: string;
  incidentId: string;
  attemptNumber: number;
  action: RecoveryAction;
  decision: RecoveryDecision;
  status: RecoveryLifecycleState;
  verificationResult?: boolean;
  evidence: string[];
  error?: string;
  startedAt: number;
  completedAt?: number;
  idempotencyKey: string; // deterministic key to prevent duplicates
}