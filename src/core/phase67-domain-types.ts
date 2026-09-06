export type PolicyEffect = 'ALLOW'|'DENY'|'REQUIRE_APPROVAL'|'CONSTRAIN'|'ESCALATE';
export type DecisionOutcome = 'AUTONOMOUSLY_ALLOWED'|'APPROVAL_REQUIRED'|'CONSTRAINED'|'ESCALATED'|'DENIED'|'EXPIRED'|'SUPERSEDED';
export type AuthorizationStatus = 'PENDING'|'AUTONOMOUSLY_ALLOWED'|'APPROVAL_REQUIRED'|'CONSTRAINED'|'ESCALATED'|'DENIED'|'EXPIRED'|'SUPERSEDED';
export type ApprovalStatus = 'PENDING'|'APPROVED'|'REJECTED'|'EXPIRED'|'REVOKED';
export type RiskLevel = 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'|'UNKNOWN';

export interface Policy {
  id: string;
  policyId: string;
  policyVersion: string;
  policyType: string;
  scope?: string;
  priority: number;
  effect: PolicyEffect;
  conditions: Record<string, unknown>;
  constraints: Record<string, unknown>;
  enforcementMode: string;
  approvalRequirement?: string;
  riskThreshold?: RiskLevel;
  effectiveFrom?: string;
  effectiveUntil?: string;
  enabled: boolean;
  owner?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  decisionId: string;
  requestId?: string;
  correlationId?: string;
  decisionType: string;
  actor?: string;
  actorType?: string;
  target?: string;
  environment?: string;
  requestedAction?: string;
  context: Record<string, unknown>;
  policyInputs: Record<string, unknown>;
  riskInputs: Record<string, unknown>;
  affectedResources: string[];
  blastRadius?: string;
  confidence?: number;
  authorizationStatus: AuthorizationStatus;
  decisionOutcome: DecisionOutcome;
  constraints: Record<string, unknown>;
  explanation?: string;
  evidenceReferences: string[];
  lineageReferences: string[];
  idempotencyKey: string;
  createdAt: string;
  evaluatedAt?: string;
  expiresAt?: string;
  version: number;
}

export interface PolicyEvaluationResult {
  outcome: DecisionOutcome;
  rationale: string;
  riskLevel: RiskLevel;
  policyIds: string[];
}
