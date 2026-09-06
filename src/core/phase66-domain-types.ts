export type PolicyStatus = 'ACTIVE'|'INACTIVE'|'EXPIRED'|'REVOKED';
export type EnforcementMode = 'ALLOW'|'DENY'|'REQUIRE_APPROVAL'|'ESCALATE'|'DEFER';
export type GovernanceDecisionType = 'ALLOW'|'DENY'|'REQUIRE_APPROVAL'|'ESCALATE'|'DEFER';
export type RiskLevel = 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'|'UNKNOWN';
export type ResilienceState = 'HEALTHY'|'DEGRADED'|'AT_RISK'|'FAILED'|'RECOVERING'|'UNKNOWN';
export type RecoveryState = 'STARTED'|'EXECUTING'|'COMPLETED'|'FAILED'|'ABORTED';
export type EscalationLevel = 'L1'|'L2'|'L3'|'CRITICAL';
export type BlastRadiusLevel = 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL';

export interface GovernancePolicy {
  id: string;
  policyId: string;
  policyVersion: string;
  policyType: string;
  scope?: string;
  priority: number;
  rules: Record<string, unknown>;
  enforcementMode: EnforcementMode;
  effectiveAt?: string;
  expiresAt?: string;
  status: PolicyStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface GovernanceDecision {
  id: string;
  decisionId: string;
  policyId: string;
  policyVersion: string;
  subjectType: string;
  subjectId: string;
  decision: GovernanceDecisionType;
  riskLevel: RiskLevel;
  rationale?: string;
  inputHash: string;
  decisionHash: string;
  createdAt: string;
}

export interface ResilienceDomain {
  id: string;
  domainId: string;
  environmentId?: string;
  region?: string;
  zone?: string;
  dependencyGroup?: string;
  criticality: RiskLevel;
  failureDomain: string;
  status: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResilienceEvent {
  id: string;
  eventId: string;
  domainId: string;
  eventType: string;
  severity: RiskLevel;
  detectedAt: string;
  resolvedAt?: string;
  state: string;
  evidence?: string;
  idempotencyKey: string;
}

export interface RecoveryPlan {
  id: string;
  recoveryPlanId: string;
  name: string;
  version: string;
  targetScope?: string;
  recoveryStrategy: string;
  prerequisites?: string[];
  maximumBlastRadius: BlastRadiusLevel;
  approvalPolicy?: string;
  status: string;
  idempotencyKey: string;
}

export interface RecoveryExecution {
  id: string;
  recoveryExecutionId: string;
  recoveryPlanId: string;
  triggerEventId?: string;
  idempotencyKey: string;
  status: RecoveryState;
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface GovernanceAction {
  id: string;
  actionId: string;
  decisionId: string;
  actionType: string;
  target?: string;
  riskLevel: RiskLevel;
  status: string;
  authorizationState: string;
  executedAt?: string;
  result?: string;
}

export interface BlastRadiusAssessment {
  id: string;
  assessmentId: string;
  actionId: string;
  affectedScope?: string;
  affectedResources?: string[];
  estimatedImpact?: string;
  riskScore: number;
  allowed: boolean;
  rationale?: string;
}

export interface Escalation {
  id: string;
  escalationId: string;
  decisionId?: string;
  severity: RiskLevel;
  escalationLevel: EscalationLevel;
  reason?: string;
  status: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface GovernanceEvidence {
  id: string;
  evidenceId: string;
  decisionId: string;
  evidenceType: string;
  contentHash: string;
  content?: string;
  source?: string;
  createdAt: string;
}

export type PolicyEvaluationResult = {
  decision: GovernanceDecisionType;
  rationale: string;
  riskLevel: RiskLevel;
};
