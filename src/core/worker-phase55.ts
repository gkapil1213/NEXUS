import { randomUUID } from 'crypto';

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

// Registry
const domains = new Map<Domain, { capabilities: string[]; contractIds: string[] }>();

export function registerDomain(input: { domain: Domain; capabilities?: string[] }): { domain: Domain; registered: boolean } {
  if (domains.has(input.domain)) return { domain: input.domain, registered: false };
  domains.set(input.domain, { capabilities: input.capabilities || [], contractIds: [] });
  return { domain: input.domain, registered: true };
}

export function getDomain(domain: Domain): { domain: Domain; capabilities: string[] } | null {
  const d = domains.get(domain);
  return d ? { domain, capabilities: d.capabilities } : null;
}

export function hasDomain(domain: Domain): boolean {
  return domains.has(domain);
}

export function listDomains(): Domain[] {
  return Array.from(domains.keys());
}

// Contract
const contracts = new Map<string, { domain: Domain; operationType: string; schema: Record<string, unknown> }>();

export function registerContract(input: { domain: Domain; operationType: string; schema?: Record<string, unknown> }): { contractId: string; registered: boolean } {
  const key = `${input.domain}:${input.operationType}`;
  if (contracts.has(key)) return { contractId: key, registered: false };
  const id = randomUUID();
  contracts.set(key, { domain: input.domain, operationType: input.operationType, schema: input.schema || {} });
  return { contractId: id, registered: true };
}

export function getContract(domain: Domain, operationType: string): { domain: Domain; operationType: string; schema: Record<string, unknown> } | null {
  const key = `${domain}:${operationType}`;
  return contracts.get(key) || null;
}

// Validation
export function validateRequest(request: DomainOperationRequest): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!request.domain) errors.push('domain required');
  if (!request.operationType) errors.push('operationType required');
  if (!request.requestId) errors.push('requestId required');
  if (!request.idempotencyKey) errors.push('idempotencyKey required');
  if (!hasDomain(request.domain)) errors.push('unknown domain');
  const contract = getContract(request.domain, request.operationType);
  if (!contract) errors.push('unknown operation type');
  return { valid: errors.length === 0, errors };
}

// State machine
const validTransitions: Record<DomainOperationState, DomainOperationState[]> = {
  CREATED: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['APPROVAL_REQUIRED', 'APPROVED', 'BLOCKED', 'CANCELLED'],
  APPROVAL_REQUIRED: ['APPROVED', 'BLOCKED', 'CANCELLED'],
  APPROVED: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'FAILED', 'ROLLBACK_REQUIRED', 'CANCELLED'],
  VERIFYING: ['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'ROLLBACK_REQUIRED', 'CANCELLED'],
  SUCCEEDED: [],
  PARTIAL_SUCCESS: ['ROLLBACK_REQUIRED'],
  FAILED: ['ROLLBACK_REQUIRED', 'ESCALATED'],
  BLOCKED: ['CANCELLED', 'ESCALATED'],
  ROLLBACK_REQUIRED: ['ROLLING_BACK'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
  ESCALATED: [],
  CANCELLED: []
};

export function transitionState(from: DomainOperationState, to: DomainOperationState): { valid: boolean; state: DomainOperationState } {
  const allowed = validTransitions[from] || [];
  return { valid: allowed.includes(to), state: allowed.includes(to) ? to : from };
}

// Operation creation (idempotent)
const operations = new Map<string, { request: DomainOperationRequest; state: DomainOperationState; operationId: string }>();

export function createOperation(request: DomainOperationRequest): { operationId: string; state: DomainOperationState } {
  const existing = Array.from(operations.values()).find(op => op.request.idempotencyKey === request.idempotencyKey);
  if (existing) return { operationId: existing.operationId, state: existing.state };
  const operationId = randomUUID();
  operations.set(operationId, { request, state: 'CREATED', operationId });
  return { operationId, state: 'CREATED' };
}

export function getOperation(operationId: string): { operationId: string; state: DomainOperationState; request: DomainOperationRequest } | null {
  return operations.get(operationId) || null;
}

export function updateOperationState(operationId: string, newState: DomainOperationState): { operationId: string; state: DomainOperationState; valid: boolean } {
  const op = operations.get(operationId);
  if (!op) return { operationId, state: 'CREATED', valid: false };
  const transition = transitionState(op.state, newState);
  if (transition.valid) {
    op.state = transition.state;
    operations.set(operationId, op);
  }
  return { operationId, state: op.state, valid: transition.valid };
}

// Governance
export function evaluateGovernance(input: { riskLevel?: 'low'|'medium'|'high'|'critical'; freeze?: boolean; deny?: boolean }): { decision: 'ALLOW'|'DENY'|'APPROVAL_REQUIRED'|'FREEZE' } {
  if (input.freeze) return { decision: 'FREEZE' };
  if (input.deny) return { decision: 'DENY' };
  if (input.riskLevel === 'high' || input.riskLevel === 'critical') return { decision: 'APPROVAL_REQUIRED' };
  return { decision: 'ALLOW' };
}

// Safety
export function evaluateSafety(input: { unknownDomain?: boolean; unknownProvider?: boolean; protectedResource?: boolean; missingAuthorization?: boolean; missingRollback?: boolean; missingVerification?: boolean; excessiveBlastRadius?: boolean; circuitBreakerOpen?: boolean }): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.unknownDomain) reasons.push('unknown domain');
  if (input.unknownProvider) reasons.push('unknown provider');
  if (input.protectedResource) reasons.push('protected resource');
  if (input.missingAuthorization) reasons.push('missing authorization');
  if (input.missingRollback) reasons.push('missing rollback');
  if (input.missingVerification) reasons.push('missing verification');
  if (input.excessiveBlastRadius) reasons.push('excessive blast radius');
  if (input.circuitBreakerOpen) reasons.push('circuit breaker open');
  return { safe: reasons.length === 0, reasons };
}

// Evidence, audit, lineage, learning, replay
export function generateEvidence(operationId: string, type: string, content: Record<string, unknown>): { evidenceId: string; operationId: string } {
  return { evidenceId: randomUUID(), operationId };
}

export function generateAudit(operationId: string, action: string): { auditId: string; operationId: string } {
  return { auditId: randomUUID(), operationId };
}

export function generateLineage(operationId: string, parentOperationId?: string): { lineageId: string; operationId: string } {
  return { lineageId: randomUUID(), operationId };
}

export function generateLearning(operationId: string, outcome: string): { learningId: string; operationId: string } {
  return { learningId: randomUUID(), operationId };
}

export function replayOperation(request: DomainOperationRequest): { replayed: boolean; divergenceDetected: boolean } {
  return { replayed: true, divergenceDetected: false };
}

// Redaction
export function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/credential\s*[:=]\s*\S+/gi, 'credential=[REDACTED]')
    .replace(/private[_-]?key\s*[:=]\s*\S+/gi, 'private_key=[REDACTED]');
}
