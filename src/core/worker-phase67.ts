import { randomUUID, createHash } from 'crypto';
import * as T from './phase67-domain-types';

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function fingerprint(input: any): string {
  return hash(JSON.stringify(input));
}

const policies = new Map<string, T.Policy>();
const decisions = new Map<string, T.Decision>();
const conflicts = new Map<string, { policyA: string; policyB: string; reason: string }>();
const approvals = new Map<string, { id: string; approvalId: string; decisionId: string; status: T.ApprovalStatus; requiredRole?: string; requestedBy?: string; approvedBy?: string; reason?: string; scope?: string; expiration?: string; createdAt: string; resolvedAt?: string }>();
const escalations = new Map<string, { id: string; escalationId: string; decisionId: string; severity: string; reason?: string; destination?: string; deadline?: string; escalationLevel: string; status: string; createdAt: string; resolvedAt?: string }>();
const evidences = new Map<string, { id: string; evidenceId: string; decisionId: string; evidenceType: string; contentHash: string; content?: string; source?: string; createdAt: string }>();

function normalizePolicy(input: any): T.Policy {
  return {
    id: input.idempotencyKey || randomUUID(),
    policyId: input.policyId || randomUUID(),
    policyVersion: input.policyVersion || '1.0',
    policyType: input.policyType || 'general',
    scope: input.scope,
    priority: input.priority || 0,
    effect: input.effect || 'ALLOW',
    conditions: input.conditions || {},
    constraints: input.constraints || {},
    enforcementMode: input.enforcementMode || 'REQUIRE_APPROVAL',
    approvalRequirement: input.approvalRequirement,
    riskThreshold: input.riskThreshold,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: input.effectiveUntil,
    enabled: input.enabled !== undefined ? input.enabled : true,
    owner: input.owner,
    idempotencyKey: input.idempotencyKey || randomUUID(),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

export function createPolicy(input: any): T.Policy {
  const id = input.idempotencyKey || randomUUID();
  if (policies.has(id)) return policies.get(id)!;
  const policy = normalizePolicy(input);
  policies.set(id, policy);
  return policy;
}

export function getPolicy(id: string): T.Policy | null { return policies.get(id) || null; }

export function validatePolicy(policy: T.Policy): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!policy.policyId) reasons.push('missing policyId');
  if (!policy.policyVersion) reasons.push('missing policyVersion');
  if (!policy.effect) reasons.push('missing effect');
  if (!policy.enabled) reasons.push('policy disabled');
  return { valid: reasons.length === 0, reasons };
}

export function resolvePolicy(policyId: string, version?: string): T.Policy | null {
  const candidates = Array.from(policies.values()).filter(p => p.policyId === policyId && (version ? p.policyVersion === version : true) && p.enabled);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.priority - a.priority) || b.policyVersion.localeCompare(a.policyVersion));
  return candidates[0];
}

export function detectConflicts(policyA: T.Policy, policyB: T.Policy): boolean {
  return policyA.scope === policyB.scope && policyA.effect !== policyB.effect;
}

export function evaluatePolicy(policy: T.Policy, input: any): T.PolicyEvaluationResult {
  const risk: T.RiskLevel = input.riskLevel || 'UNKNOWN';
  let outcome: T.DecisionOutcome;
  switch (policy.effect) {
    case 'ALLOW': outcome = 'AUTONOMOUSLY_ALLOWED'; break;
    case 'DENY': outcome = 'DENIED'; break;
    case 'ESCALATE': outcome = 'ESCALATED'; break;
    case 'CONSTRAIN': outcome = 'CONSTRAINED'; break;
    default: outcome = risk === 'HIGH' || risk === 'CRITICAL' ? 'APPROVAL_REQUIRED' : 'AUTONOMOUSLY_ALLOWED';
  }
  return { outcome, rationale: `policy ${policy.effect.toLowerCase()}`, riskLevel: risk, policyIds: [policy.policyId] };
}

export function evaluateDecision(input: any): T.Decision {
  const policyId = input.policyId;
  const policy = policyId ? resolvePolicy(policyId) : null;
  if (!policy) {
    const decision: T.Decision = {
      id: randomUUID(),
      decisionId: randomUUID(),
      decisionType: input.decisionType || 'unknown',
      context: input.context || {},
      policyInputs: input.policyInputs || {},
      riskInputs: input.riskInputs || {},
      affectedResources: input.affectedResources || [],
      authorizationStatus: 'DENIED',
      decisionOutcome: 'DENIED',
      constraints: {},
      evidenceReferences: [],
      lineageReferences: [],
      idempotencyKey: input.idempotencyKey || randomUUID(),
      createdAt: new Date().toISOString(),
      version: 1,
    };
    decisions.set(decision.decisionId, decision);
    return decision;
  }
  const evalResult = evaluatePolicy(policy, input);
  const decision: T.Decision = {
    id: randomUUID(),
    decisionId: randomUUID(),
    decisionType: input.decisionType || 'unknown',
    context: input.context || {},
    policyInputs: input.policyInputs || {},
    riskInputs: input.riskInputs || {},
    affectedResources: input.affectedResources || [],
    authorizationStatus: evalResult.outcome as any,
    decisionOutcome: evalResult.outcome,
    constraints: {},
    evidenceReferences: [],
    lineageReferences: [],
    idempotencyKey: input.idempotencyKey || randomUUID(),
    createdAt: new Date().toISOString(),
    version: 1,
  };
  decisions.set(decision.decisionId, decision);
  return decision;
}

export function assessRisk(input: any): { riskScore: number; riskLevel: T.RiskLevel; factors: string[] } {
  let score = 0;
  const factors: string[] = [];
  if (input.operationalRisk) score += input.operationalRisk;
  if (input.securityRisk) score += input.securityRisk;
  if (input.reliabilityRisk) score += input.reliabilityRisk;
  if (input.dataRisk) score += input.dataRisk;
  if (input.blastRadius === 'CRITICAL') score += 5;
  if (input.blastRadius === 'HIGH') score += 3;
  if (input.reversibility === 'LOW') score += 3;
  let riskLevel: T.RiskLevel;
  if (score >= 20) riskLevel = 'CRITICAL';
  else if (score >= 10) riskLevel = 'HIGH';
  else if (score >= 3) riskLevel = 'MEDIUM';
  else riskLevel = 'LOW';
  return { riskScore: score, riskLevel, factors };
}

export function authorizeDecision(decision: T.Decision, approvalStatus?: T.ApprovalStatus): T.AuthorizationStatus {
  if (decision.decisionOutcome === 'DENIED') return 'DENIED';
  if (decision.decisionOutcome === 'ESCALATED') return 'ESCALATED';
  if (decision.decisionOutcome === 'CONSTRAINED') return 'CONSTRAINED';
  if (decision.decisionOutcome === 'APPROVAL_REQUIRED') {
    return approvalStatus === 'APPROVED' ? 'AUTONOMOUSLY_ALLOWED' : 'APPROVAL_REQUIRED';
  }
  return 'AUTONOMOUSLY_ALLOWED';
}

export function requestApproval(decisionId: string, requiredRole?: string): { approvalId: string; status: T.ApprovalStatus } {
  const id = randomUUID();
  approvals.set(id, { id, approvalId: id, decisionId, status: 'PENDING', requiredRole, createdAt: new Date().toISOString() });
  return { approvalId: id, status: 'PENDING' };
}

export function resolveApproval(approvalId: string, decision: T.ApprovalStatus, approvedBy?: string): boolean {
  const approval = approvals.get(approvalId);
  if (!approval) return false;
  approval.status = decision;
  approval.approvedBy = approvedBy;
  approval.resolvedAt = new Date().toISOString();
  approvals.set(approvalId, approval);
  return true;
}

export function createEscalation(decisionId: string, severity: string, reason?: string): { escalationId: string; status: string } {
  const id = randomUUID();
  escalations.set(id, { id, escalationId: id, decisionId, severity, reason, escalationLevel: 'L1', status: 'OPEN', createdAt: new Date().toISOString() });
  return { escalationId: id, status: 'OPEN' };
}

export function resolveEscalation(escalationId: string): boolean {
  const esc = escalations.get(escalationId);
  if (!esc) return false;
  esc.status = 'RESOLVED';
  esc.resolvedAt = new Date().toISOString();
  escalations.set(escalationId, esc);
  return true;
}

export function createEvidence(decisionId: string, evidenceType: string, content: string): { evidenceId: string; contentHash: string } {
  const id = randomUUID();
  const contentHash = hash(content);
  evidences.set(id, { id, evidenceId: id, decisionId, evidenceType, contentHash, content, createdAt: new Date().toISOString() });
  return { evidenceId: id, contentHash };
}

export function replayDecision(input: any): { replayed: boolean; divergenceDetected: boolean; result: any } {
  const first = evaluateDecision(input);
  const second = evaluateDecision(input);
  return { replayed: true, divergenceDetected: first.decisionOutcome !== second.decisionOutcome, result: second };
}

export function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/access[_-]?token\s*[:=]\s*\S+/gi, 'access_token=[REDACTED]');
}
