export type Domain = 'DECISION' | 'EXECUTION' | 'OBSERVABILITY' | 'INCIDENT' | 'RECOVERY' | 'OPTIMIZATION' | 'COMPLIANCE' | 'KNOWLEDGE' | 'EVIDENCE' | 'AUDIT' | 'LINEAGE' | 'LEARNING' | 'GOVERNANCE' | 'SAFETY' | 'ROLLBACK' | 'VERIFICATION' | 'APPROVAL' | 'RESOURCE' | 'PROVIDER';

export type DomainOperationState = 'CREATED' | 'VALIDATING' | 'READY' | 'APPROVAL_REQUIRED' | 'APPROVED' | 'EXECUTING' | 'VERIFYING' | 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'BLOCKED' | 'ROLLBACK_REQUIRED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'ESCALATED' | 'CANCELLED';

export interface DomainOperationRequest {
  domain: Domain;
  operationType: string;
  requestId: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKey: string;
  actor?: string;
  requestedAction?: string;
  target?: string;
  context?: Record<string, string | number | boolean | null>;
  authorizationContext?: Record<string, unknown>;
  riskContext?: Record<string, unknown>;
}

export interface DomainOperationResult {
  operationId: string;
  status: 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS' | 'BLOCKED' | 'APPROVAL_REQUIRED' | 'SAFETY_BLOCKED' | 'GOVERNANCE_DENIED' | 'UNKNOWN_PROVIDER' | 'UNKNOWN_RESOURCE' | 'VERIFICATION_FAILED' | 'ROLLBACK_REQUIRED';
  reason?: string;
  evidenceId?: string;
  auditId?: string;
  lineageId?: string;
  verification?: Record<string, unknown>;
  rollback?: Record<string, unknown>;
  nextAction?: string;
}

export interface DomainContract {
  domain: Domain;
  operationType: string;
  schema: Record<string, unknown>;
}

export interface DomainCapability {
  name: string;
  description?: string;
}

export interface DomainApproval {
  approvalId: string;
  operationId: string;
  approver: string;
  scope: string;
  decision: 'APPROVED' | 'REJECTED' | 'PENDING' | 'EXPIRED' | 'INVALID';
  createdAt: string;
  expiresAt?: string;
  reason?: string;
}

export interface DomainRisk {
  riskScore: number;
  blastRadius: number;
  confidence: number;
  reversibility: number;
  resourceCriticality: number;
  securityImpact: number;
  complianceImpact: number;
  operationalImpact: number;
}

export interface DomainEvidence {
  evidenceId: string;
  operationId: string;
  type: string;
  source: string;
  timestamp: string;
  integrityHash: string;
  content: Record<string, unknown>;
  confidence: number;
}

export interface DomainAuditRecord {
  auditId: string;
  operationId: string;
  domain: Domain;
  actor: string;
  action: string;
  beforeState?: DomainOperationState;
  afterState?: DomainOperationState;
  timestamp: string;
  result: string;
  reason?: string;
}

export interface DomainLineage {
  lineageId: string;
  operationId: string;
  parentOperationId?: string;
  rootOperationId?: string;
  correlationId?: string;
  causationId?: string;
  sourceDomain: Domain;
  targetDomain: Domain;
}

export interface DomainLearningOutcome {
  learningId: string;
  operationId: string;
  patternType: 'SUCCESS' | 'FAILURE' | 'REGRESSION' | 'ROLLBACK' | 'GOVERNANCE' | 'SAFETY';
  outcome: string;
  recommendation?: string;
  timestamp: string;
}

export type { DomainOperationRequest as Phase55DomainRequest, DomainOperationResult as Phase55DomainResult };
