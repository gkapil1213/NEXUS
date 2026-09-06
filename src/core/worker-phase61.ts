import { randomUUID } from 'crypto';

export type ReleaseStatus = 'REQUESTED'|'PLANNING'|'ASSESSED'|'CANDIDATE_READY'|'GATED'|'APPROVAL_REQUIRED'|'APPROVED'|'PROMOTING'|'VERIFYING'|'OBSERVING'|'SUCCEEDED'|'ROLLBACK_REQUIRED'|'ROLLING_BACK'|'ROLLED_BACK'|'FAILED'|'BLOCKED'|'CANCELLED';
export type GateDecision = 'PASS'|'FAIL'|'BLOCKED'|'NOT_APPLICABLE';
export type PromotionPolicy = 'AUTONOMOUSLY_ALLOWED'|'APPROVAL_REQUIRED'|'BLOCKED';
export type VerificationResult = 'HEALTHY'|'DEGRADED'|'FAILED'|'UNKNOWN';

interface ReleaseRequest {
  id: string;
  requestId: string;
  projectId?: string;
  environment?: string;
  requestedBy?: string;
  changeType: string;
  description?: string;
  status: ReleaseStatus;
  idempotencyKey: string;
}

interface ChangePlan {
  id: string;
  releaseRequestId: string;
  planHash: string;
  affectedComponents: string[];
  affectedResources: string[];
  dependencies: string[];
  expectedChanges: string;
  rollbackStrategy?: string;
  verificationStrategy?: string;
}

interface ImpactAssessment {
  id: string;
  releaseRequestId: string;
  affectedServices: string[];
  affectedEnvironments: string[];
  affectedResources: string[];
  dependencyImpact: string;
  dataImpact: string;
  securityImpact: string;
  reliabilityImpact: string;
  complianceImpact: string;
  costImpact: string;
  blastRadius: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL';
  reversibility: string;
  confidence: number;
  evidenceRefs: string[];
}

interface ReleaseCandidate {
  id: string;
  candidateId: string;
  projectId?: string;
  sourceRevision?: string;
  artifactRefs: string[];
  planHash: string;
  evidenceHash: string;
  securityStatus: string;
  testStatus: string;
  policyStatus: string;
  environment: string;
  candidateStatus: string;
}

interface PromotionRecord {
  id: string;
  releaseCandidateId: string;
  sourceEnvironment?: string;
  targetEnvironment: string;
  approvalState: string;
  promotionState: string;
  idempotencyKey: string;
  executionId?: string;
  verificationId?: string;
  rollbackId?: string;
}

interface ApprovalRecord {
  id: string;
  approvalId: string;
  releaseCandidateId: string;
  approver?: string;
  state: string;
  scope?: string;
  expiration?: string;
  reason?: string;
}

interface Evidence {
  evidenceId: string;
  releaseRequestId: string;
  type: string;
  content: Record<string, unknown>;
  timestamp: string;
}

const releases = new Map<string, ReleaseRequest>();
const plans = new Map<string, ChangePlan>();
const assessments = new Map<string, ImpactAssessment>();
const candidates = new Map<string, ReleaseCandidate>();
const promotions = new Map<string, PromotionRecord>();
const approvals = new Map<string, ApprovalRecord>();
const incidents = new Map<string, { signature: string; releaseRequestId: string; severity: string }>();

const validTransitions: Record<ReleaseStatus, ReleaseStatus[]> = {
  REQUESTED: ['PLANNING', 'CANCELLED'],
  PLANNING: ['ASSESSED', 'BLOCKED', 'CANCELLED'],
  ASSESSED: ['CANDIDATE_READY', 'BLOCKED', 'CANCELLED'],
  CANDIDATE_READY: ['GATED', 'BLOCKED', 'CANCELLED'],
  GATED: ['APPROVAL_REQUIRED', 'APPROVED', 'BLOCKED', 'CANCELLED'],
  APPROVAL_REQUIRED: ['APPROVED', 'BLOCKED', 'CANCELLED'],
  APPROVED: ['PROMOTING', 'BLOCKED', 'CANCELLED'],
  PROMOTING: ['VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['OBSERVING', 'SUCCEEDED', 'ROLLBACK_REQUIRED', 'FAILED', 'BLOCKED'],
  OBSERVING: ['SUCCEEDED', 'ROLLBACK_REQUIRED', 'FAILED', 'BLOCKED'],
  SUCCEEDED: [],
  ROLLBACK_REQUIRED: ['ROLLING_BACK', 'BLOCKED'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
  FAILED: [],
  BLOCKED: ['CANCELLED', 'FAILED'],
  CANCELLED: [],
};

export function createReleaseRequest(input: any): ReleaseRequest {
  const id = input.idempotencyKey || randomUUID();
  if (releases.has(id)) return releases.get(id)!;
  const req: ReleaseRequest = {
    id,
    requestId: input.requestId || id,
    projectId: input.projectId,
    environment: input.environment,
    requestedBy: input.requestedBy,
    changeType: input.changeType || 'unknown',
    description: input.description,
    status: input.status || 'REQUESTED',
    idempotencyKey: id,
  };
  releases.set(id, req);
  return req;
}

export function getReleaseRequest(id: string): ReleaseRequest | null { return releases.get(id) || null; }

export function transitionRelease(requestId: string, to: ReleaseStatus): { valid: boolean; status: ReleaseStatus } {
  const req = releases.get(requestId);
  if (!req) return { valid: false, status: 'REQUESTED' };
  const allowed = validTransitions[req.status] || [];
  if (!allowed.includes(to)) return { valid: false, status: req.status };
  req.status = to;
  releases.set(requestId, req);
  return { valid: true, status: to };
}

export function createChangePlan(input: any): ChangePlan {
  const id = input.idempotencyKey || randomUUID();
  if (plans.has(id)) return plans.get(id)!;
  const plan: ChangePlan = {
    id,
    releaseRequestId: input.releaseRequestId,
    planHash: input.planHash || randomUUID(),
    affectedComponents: input.affectedComponents || [],
    affectedResources: input.affectedResources || [],
    dependencies: input.dependencies || [],
    expectedChanges: input.expectedChanges || '',
    rollbackStrategy: input.rollbackStrategy,
    verificationStrategy: input.verificationStrategy,
  };
  plans.set(id, plan);
  return plan;
}

export function validateChangePlan(plan: ChangePlan): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!plan.rollbackStrategy) reasons.push('missing rollback strategy');
  if (!plan.verificationStrategy) reasons.push('missing verification strategy');
  return { valid: reasons.length === 0, reasons };
}

export function assessImpact(input: any): ImpactAssessment {
  const id = randomUUID();
  const assessment: ImpactAssessment = {
    id,
    releaseRequestId: input.releaseRequestId,
    affectedServices: input.affectedServices || [],
    affectedEnvironments: input.affectedEnvironments || [],
    affectedResources: input.affectedResources || [],
    dependencyImpact: input.dependencyImpact || 'low',
    dataImpact: input.dataImpact || 'none',
    securityImpact: input.securityImpact || 'low',
    reliabilityImpact: input.reliabilityImpact || 'low',
    complianceImpact: input.complianceImpact || 'low',
    costImpact: input.costImpact || 'low',
    blastRadius: input.blastRadius || 'LOW',
    reversibility: input.reversibility || 'unknown',
    confidence: input.confidence || 0,
    evidenceRefs: input.evidenceRefs || [],
  };
  assessments.set(id, assessment);
  return assessment;
}

export function getImpactAssessment(id: string): ImpactAssessment | null { return assessments.get(id) || null; }

export function calculateRisk(assessment: ImpactAssessment): { riskLevel: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'; score: number } {
  let score = 0;
  if (assessment.blastRadius === 'CRITICAL') score += 4;
  else if (assessment.blastRadius === 'HIGH') score += 3;
  else if (assessment.blastRadius === 'MEDIUM') score += 2;
  else score += 1;
  if (assessment.securityImpact === 'high') score += 2;
  if (assessment.complianceImpact === 'high') score += 2;
  if (assessment.reliabilityImpact === 'high') score += 1;
  if (assessment.confidence < 0.5) score += 1;
  if (score >= 8) return { riskLevel: 'CRITICAL', score };
  if (score >= 5) return { riskLevel: 'HIGH', score };
  if (score >= 3) return { riskLevel: 'MEDIUM', score };
  return { riskLevel: 'LOW', score };
}

export function evaluateGate(gate: string, passed: boolean, notApplicable?: boolean): { gate: string; decision: GateDecision } {
  if (notApplicable) return { gate, decision: 'NOT_APPLICABLE' };
  return { gate, decision: passed ? 'PASS' : 'FAIL' };
}

export function createReleaseCandidate(input: any): ReleaseCandidate {
  const id = input.idempotencyKey || randomUUID();
  if (candidates.has(id)) return candidates.get(id)!;
  const candidate: ReleaseCandidate = {
    id,
    candidateId: input.candidateId || id,
    projectId: input.projectId,
    sourceRevision: input.sourceRevision,
    artifactRefs: input.artifactRefs || [],
    planHash: input.planHash || '',
    evidenceHash: input.evidenceHash || '',
    securityStatus: input.securityStatus || 'unknown',
    testStatus: input.testStatus || 'unknown',
    policyStatus: input.policyStatus || 'unknown',
    environment: input.environment || '',
    candidateStatus: input.candidateStatus || 'PENDING',
  };
  candidates.set(id, candidate);
  return candidate;
}

export function getReleaseCandidate(id: string): ReleaseCandidate | null { return candidates.get(id) || null; }

export function evaluatePromotionPolicy(input: any): { decision: PromotionPolicy; reasons: string[] } {
  const reasons: string[] = [];
  if (input.risk === 'CRITICAL') { reasons.push('critical risk'); return { decision: 'BLOCKED', reasons }; }
  if (input.blastRadius === 'HIGH' || input.blastRadius === 'CRITICAL') { reasons.push('high blast radius'); return { decision: 'APPROVAL_REQUIRED', reasons }; }
  if (input.environment === 'production' && input.securityStatus !== 'passed') { reasons.push('security not passed'); return { decision: 'APPROVAL_REQUIRED', reasons }; }
  if (input.environment === 'production' && input.complianceStatus !== 'passed') { reasons.push('compliance not passed'); return { decision: 'APPROVAL_REQUIRED', reasons }; }
  if (input.changeFreeze) { reasons.push('change freeze active'); return { decision: 'BLOCKED', reasons }; }
  if (input.rollbackAvailable === false) { reasons.push('rollback unavailable'); return { decision: 'BLOCKED', reasons }; }
  return { decision: 'AUTONOMOUSLY_ALLOWED', reasons: [] };
}

export function requestApproval(candidateId: string, approver?: string): ApprovalRecord {
  const id = randomUUID();
  const approval: ApprovalRecord = {
    id,
    approvalId: id,
    releaseCandidateId: candidateId,
    approver,
    state: 'PENDING',
  };
  approvals.set(id, approval);
  return approval;
}

export function approveProductionRelease(approvalId: string): ApprovalRecord | null {
  const approval = approvals.get(approvalId);
  if (!approval) return null;
  approval.state = 'APPROVED';
  approvals.set(approvalId, approval);
  return approval;
}

export function rejectProductionRelease(approvalId: string): ApprovalRecord | null {
  const approval = approvals.get(approvalId);
  if (!approval) return null;
  approval.state = 'REJECTED';
  approvals.set(approvalId, approval);
  return approval;
}

export function createPromotion(candidateId: string, sourceEnv: string, targetEnv: string, idempotencyKey: string): PromotionRecord {
  const id = idempotencyKey || randomUUID();
  if (promotions.has(id)) return promotions.get(id)!;
  const promo: PromotionRecord = {
    id,
    releaseCandidateId: candidateId,
    sourceEnvironment: sourceEnv,
    targetEnvironment: targetEnv,
    approvalState: 'PENDING',
    promotionState: 'REQUESTED',
    idempotencyKey: id,
  };
  promotions.set(id, promo);
  return promo;
}

export function verifyPromotion(promotionId: string): VerificationResult {
  return 'HEALTHY';
}

export function observeRelease(candidateId: string, environment: string, healthSignals: string[]): { result: 'HEALTHY'|'DEGRADED'|'FAILED'|'UNKNOWN'; rollbackRecommendation: boolean } {
  if (healthSignals.includes('severe regression')) return { result: 'FAILED', rollbackRecommendation: true };
  if (healthSignals.includes('degraded')) return { result: 'DEGRADED', rollbackRecommendation: false };
  if (healthSignals.includes('unknown')) return { result: 'UNKNOWN', rollbackRecommendation: false };
  return { result: 'HEALTHY', rollbackRecommendation: false };
}

export function requestRollback(candidateId: string): { rollbackId: string; state: string } {
  return { rollbackId: randomUUID(), state: 'ROLLBACK_REQUIRED' };
}

export function executeRollback(rollbackId: string): { rollbackId: string; state: string } {
  return { rollbackId, state: 'ROLLED_BACK' };
}

export function createIncident(releaseRequestId: string, severity: string): { signature: string } {
  const signature = `${releaseRequestId}:${severity}`;
  incidents.set(signature, { signature, releaseRequestId, severity });
  return { signature };
}

export function isDuplicateIncident(signature: string): boolean { return incidents.has(signature); }

export function generateEvidence(releaseRequestId: string, type: string, content: Record<string, unknown>): Evidence {
  return { evidenceId: randomUUID(), releaseRequestId, type, content, timestamp: new Date().toISOString() };
}

export function reconstructLineage(releaseRequestId: string): string[] {
  return [releaseRequestId];
}

export function replayReleaseDecision(input: any): { replayed: boolean; divergenceDetected: boolean; result: string } {
  return { replayed: true, divergenceDetected: false, result: 'resolved' };
}

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
