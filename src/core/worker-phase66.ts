import { randomUUID, createHash } from 'crypto';
import * as T from './phase66-domain-types';

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function fingerprint(input: any): string {
  return hash(JSON.stringify(input));
}

// In-memory stores for deterministic tests
const policies = new Map<string, T.GovernancePolicy>();
const decisions = new Map<string, T.GovernanceDecision>();
const domains = new Map<string, T.ResilienceDomain>();
const events = new Map<string, T.ResilienceEvent>();
const recoveryPlans = new Map<string, T.RecoveryPlan>();
const recoveryExecutions = new Map<string, T.RecoveryExecution>();
const escalations = new Map<string, T.Escalation>();
const evidences = new Map<string, T.GovernanceEvidence>();

export function createPolicy(input: any): T.GovernancePolicy {
  const id = input.idempotencyKey || randomUUID();
  if (policies.has(id)) return policies.get(id)!;
  const policy: T.GovernancePolicy = {
    id,
    policyId: input.policyId || id,
    policyVersion: input.policyVersion || '1.0',
    policyType: input.policyType || 'general',
    scope: input.scope,
    priority: input.priority || 0,
    rules: input.rules || {},
    enforcementMode: input.enforcementMode || 'REQUIRE_APPROVAL',
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt,
    status: input.status || 'ACTIVE',
    idempotencyKey: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  policies.set(id, policy);
  return policy;
}

export function getPolicy(id: string): T.GovernancePolicy | null {
  return policies.get(id) || null;
}

export function validatePolicy(policy: T.GovernancePolicy): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!policy.policyId) reasons.push('missing policyId');
  if (!policy.policyVersion) reasons.push('missing policyVersion');
  if (!policy.enforcementMode) reasons.push('missing enforcementMode');
  if (policy.status === 'EXPIRED') reasons.push('policy expired');
  return { valid: reasons.length === 0, reasons };
}

export function resolvePolicyVersion(policyId: string, version?: string): T.GovernancePolicy | null {
  const candidates = Array.from(policies.values()).filter(p => p.policyId === policyId && (version ? p.policyVersion === version : true) && p.status === 'ACTIVE');
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.priority - a.priority) || b.policyVersion.localeCompare(a.policyVersion));
  return candidates[0];
}

export function detectConflictingPolicies(policyA: T.GovernancePolicy, policyB: T.GovernancePolicy): boolean {
  return policyA.enforcementMode !== policyB.enforcementMode && policyA.scope === policyB.scope;
}

export function evaluatePolicy(policy: T.GovernancePolicy, input: any): T.PolicyEvaluationResult {
  const risk: T.RiskLevel = input.riskLevel || 'UNKNOWN';
  if (policy.status !== 'ACTIVE') {
    return { decision: 'DENY', rationale: `policy ${policy.status.toLowerCase()}`, riskLevel: risk };
  }
  switch (policy.enforcementMode) {
    case 'ALLOW': return { decision: 'ALLOW', rationale: 'policy allows', riskLevel: risk };
    case 'DENY': return { decision: 'DENY', rationale: 'policy denies', riskLevel: risk };
    case 'ESCALATE': return { decision: 'ESCALATE', rationale: 'policy requires escalation', riskLevel: risk };
    case 'DEFER': return { decision: 'DEFER', rationale: 'policy defers action', riskLevel: risk };
    default:
      if (risk === 'CRITICAL' || risk === 'HIGH') return { decision: 'REQUIRE_APPROVAL', rationale: 'high risk requires approval', riskLevel: risk };
      return { decision: 'REQUIRE_APPROVAL', rationale: 'default approval required', riskLevel: risk };
  }
}

export function evaluateGovernance(input: any): T.GovernanceDecision {
  const policy = resolvePolicyVersion(input.policyId, input.policyVersion);
  const result = policy ? evaluatePolicy(policy, input) : { decision: 'DENY' as T.GovernanceDecisionType, rationale: 'no applicable policy', riskLevel: (input.riskLevel || 'UNKNOWN') as T.RiskLevel };
  const inputHash = fingerprint(input);
  const decisionHash = fingerprint({ inputHash, decision: result.decision, policyId: policy?.policyId, policyVersion: policy?.policyVersion, riskLevel: result.riskLevel });
  if (decisions.has(decisionHash)) return decisions.get(decisionHash)!;
  const decision: T.GovernanceDecision = {
    id: randomUUID(),
    decisionId: decisionHash,
    policyId: policy?.policyId || '',
    policyVersion: policy?.policyVersion || '',
    subjectType: input.subjectType || 'unknown',
    subjectId: input.subjectId || 'unknown',
    decision: result.decision,
    riskLevel: result.riskLevel,
    rationale: result.rationale,
    inputHash,
    decisionHash,
    createdAt: new Date().toISOString(),
  };
  decisions.set(decisionHash, decision);
  return decision;
}

export function registerResilienceDomain(input: any): T.ResilienceDomain {
  const id = input.idempotencyKey || randomUUID();
  if (domains.has(id)) return domains.get(id)!;
  const domain: T.ResilienceDomain = {
    id,
    domainId: input.domainId || id,
    environmentId: input.environmentId,
    region: input.region,
    zone: input.zone,
    dependencyGroup: input.dependencyGroup,
    criticality: input.criticality || 'MEDIUM',
    failureDomain: input.failureDomain || 'default',
    status: input.status || 'ACTIVE',
    idempotencyKey: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  domains.set(id, domain);
  return domain;
}

export function evaluateFailureDomain(domainId: string): T.RiskLevel {
  const domain = domains.get(domainId);
  return domain ? domain.criticality : 'UNKNOWN';
}

export function calculateDependencyImpact(domains: string[]): number {
  return domains.length;
}

export function detectSingleFailureDomainRisk(domainIds: string[]): boolean {
  const fd = new Set(domainIds.map(d => {
    const domain = domains.get(d);
    return domain ? domain.failureDomain : d;
  }));
  return fd.size === 1;
}

export function assessBlastRadius(input: any): T.BlastRadiusAssessment {
  const riskScore = input.resourceCount || 0;
  const allowed = input.protected ? false : riskScore < 10;
  return {
    id: randomUUID(),
    assessmentId: input.assessmentId || randomUUID(),
    actionId: input.actionId || 'unknown',
    affectedScope: input.scope,
    affectedResources: input.resources || [],
    estimatedImpact: input.impact,
    riskScore,
    allowed,
    rationale: input.rationale,
  };
}

export function detectResilienceEvent(input: any): T.ResilienceEvent {
  const id = input.idempotencyKey || randomUUID();
  if (events.has(id)) return events.get(id)!;
  const event: T.ResilienceEvent = {
    id,
    eventId: input.eventId || id,
    domainId: input.domainId,
    eventType: input.eventType || 'generic',
    severity: input.severity || 'MEDIUM',
    detectedAt: input.detectedAt || new Date().toISOString(),
    state: input.state || 'OPEN',
    evidence: input.evidence,
    idempotencyKey: id,
  };
  events.set(id, event);
  return event;
}

export function evaluateResilienceState(domainId: string): T.ResilienceState {
  const domain = domains.get(domainId);
  return domain && domain.status === 'ACTIVE' ? 'HEALTHY' : 'UNKNOWN';
}

export function registerRecoveryPlan(input: any): T.RecoveryPlan {
  const id = input.idempotencyKey || randomUUID();
  if (recoveryPlans.has(id)) return recoveryPlans.get(id)!;
  const plan: T.RecoveryPlan = {
    id,
    recoveryPlanId: input.recoveryPlanId || id,
    name: input.name || 'plan',
    version: input.version || '1.0',
    targetScope: input.targetScope,
    recoveryStrategy: input.recoveryStrategy || 'manual',
    prerequisites: input.prerequisites || [],
    maximumBlastRadius: input.maximumBlastRadius || 'MEDIUM',
    approvalPolicy: input.approvalPolicy,
    status: input.status || 'ACTIVE',
    idempotencyKey: id,
  };
  recoveryPlans.set(id, plan);
  return plan;
}

export function validateRecoveryPlan(plan: T.RecoveryPlan): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!plan.name) reasons.push('missing name');
  if (!plan.recoveryStrategy) reasons.push('missing strategy');
  if (!plan.maximumBlastRadius) reasons.push('missing blast radius limit');
  return { valid: reasons.length === 0, reasons };
}

export function selectRecoveryPlan(domainId: string): T.RecoveryPlan | null {
  const candidates = Array.from(recoveryPlans.values()).filter(p => p.status === 'ACTIVE');
  return candidates.length ? candidates[0] : null;
}

export function startRecoveryExecution(planId: string, idempotencyKey: string): T.RecoveryExecution {
  const id = idempotencyKey || randomUUID();
  if (recoveryExecutions.has(id)) return recoveryExecutions.get(id)!;
  const execution: T.RecoveryExecution = {
    id,
    recoveryExecutionId: id,
    recoveryPlanId: planId,
    idempotencyKey: id,
    status: 'STARTED',
    startedAt: new Date().toISOString(),
  };
  recoveryExecutions.set(id, execution);
  return execution;
}

export function completeRecoveryExecution(executionId: string): T.RecoveryExecution | null {
  const exec = recoveryExecutions.get(executionId);
  if (!exec) return null;
  exec.status = 'COMPLETED';
  exec.completedAt = new Date().toISOString();
  recoveryExecutions.set(executionId, exec);
  return exec;
}

export function failRecoveryExecution(executionId: string): T.RecoveryExecution | null {
  const exec = recoveryExecutions.get(executionId);
  if (!exec) return null;
  exec.status = 'FAILED';
  exec.completedAt = new Date().toISOString();
  recoveryExecutions.set(executionId, exec);
  return exec;
}

export function abortRecoveryExecution(executionId: string): T.RecoveryExecution | null {
  const exec = recoveryExecutions.get(executionId);
  if (!exec) return null;
  exec.status = 'ABORTED';
  exec.completedAt = new Date().toISOString();
  recoveryExecutions.set(executionId, exec);
  return exec;
}

export function evaluateEscalation(input: any): boolean {
  return input.severity === 'CRITICAL' || input.repeatedFailure === true;
}

export function createEscalation(input: any): T.Escalation {
  const id = input.idempotencyKey || randomUUID();
  if (escalations.has(id)) return escalations.get(id)!;
  const escalation: T.Escalation = {
    id,
    escalationId: input.escalationId || id,
    decisionId: input.decisionId,
    severity: input.severity || 'HIGH',
    escalationLevel: input.escalationLevel || 'L1',
    reason: input.reason,
    status: input.status || 'OPEN',
    createdAt: new Date().toISOString(),
  };
  escalations.set(id, escalation);
  return escalation;
}

export function advanceEscalation(escalationId: string): T.Escalation | null {
  const esc = escalations.get(escalationId);
  if (!esc) return null;
  const levels: T.EscalationLevel[] = ['L1','L2','L3','CRITICAL'];
  const idx = levels.indexOf(esc.escalationLevel);
  if (idx < levels.length - 1) esc.escalationLevel = levels[idx + 1];
  escalations.set(escalationId, esc);
  return esc;
}

export function resolveEscalation(escalationId: string): T.Escalation | null {
  const esc = escalations.get(escalationId);
  if (!esc) return null;
  esc.status = 'RESOLVED';
  esc.resolvedAt = new Date().toISOString();
  escalations.set(escalationId, esc);
  return esc;
}

export function createEvidence(decisionId: string, evidenceType: string, content: string): T.GovernanceEvidence {
  const contentHash = hash(content);
  const id = randomUUID();
  const evidence: T.GovernanceEvidence = {
    id,
    evidenceId: id,
    decisionId,
    evidenceType,
    contentHash,
    content,
    source: inputSource(),
    createdAt: new Date().toISOString(),
  };
  evidences.set(id, evidence);
  return evidence;
}

function inputSource(): string {
  return 'phase66';
}

export function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/access[_-]?token\s*[:=]\s*\S+/gi, 'access_token=[REDACTED]')
    .replace(/private[_-]?key\s*[:=]\s*\S+/gi, 'private_key=[REDACTED]');
}

// Re-export types for convenience
export * from './phase66-domain-types';

