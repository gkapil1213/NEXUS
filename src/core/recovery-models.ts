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