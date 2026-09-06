import { randomUUID, createHash } from 'crypto';
import * as T from './phase69-domain-types';

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function fingerprint(input: any): string {
  return hash(JSON.stringify(input));
}

const observations = new Map<string, T.LearningObservation>();
const correlations = new Map<string, T.LearningCorrelation>();
const patterns = new Map<string, T.LearnedPattern>();
const lessons = new Map<string, T.ValidatedLesson>();
const candidates = new Map<string, T.ImprovementCandidate>();
const proposals = new Map<string, T.AdaptationProposal>();
const evidences = new Map<string, { id: string; evidenceId: string; contentHash: string; content?: string; source?: string; createdAt: string }>();

export function ingestObservation(input: any): T.LearningObservation {
  const id = input.idempotencyKey || fingerprint(input);
  if (observations.has(id)) return observations.get(id)!;
  const obs: T.LearningObservation = {
    id,
    observationId: input.observationId || id,
    sourceType: input.sourceType || 'generic',
    sourceId: input.sourceId,
    eventData: input.eventData || {},
    status: input.status || 'RAW',
    confidence: input.confidence || 0,
    evidenceRefs: input.evidenceRefs || [],
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: id,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
  observations.set(id, obs);
  return obs;
}

export function correlateObservations(participantIds: string[], relationshipType: string, confidence: number): T.LearningCorrelation {
  const correlationId = fingerprint({ participantIds, relationshipType });
  if (correlations.has(correlationId)) return correlations.get(correlationId)!;
  const correlation: T.LearningCorrelation = {
    id: randomUUID(),
    correlationId,
    participantIds,
    relationshipType,
    confidence,
    supportingEvidence: [],
    contradictoryEvidence: [],
    correlationStatus: 'PROPOSED',
    isCausal: relationshipType.startsWith('CAUSAL'),
    createdAt: new Date().toISOString(),
  };
  correlations.set(correlationId, correlation);
  return correlation;
}

export function learnPattern(input: any): T.LearnedPattern {
  const id = input.idempotencyKey || fingerprint(input);
  if (patterns.has(id)) return patterns.get(id)!;
  const pattern: T.LearnedPattern = {
    id,
    patternId: input.patternId || id,
    description: input.description || '',
    inputs: input.inputs || {},
    observedConditions: input.observedConditions || {},
    expectedOutcome: input.expectedOutcome || '',
    supportingEvidence: input.supportingEvidence || [],
    confidence: input.confidence || 0,
    validationCount: input.validationCount || 0,
    failureCount: input.failureCount || 0,
    lastObservedAt: input.lastObservedAt,
    applicabilityScope: input.applicabilityScope,
    riskLevel: input.riskLevel || 'LOW',
    lifecycleState: input.lifecycleState || 'PROPOSED',
    idempotencyKey: id,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
  patterns.set(id, pattern);
  return pattern;
}

export function validateLesson(input: any): T.ValidatedLesson {
  const id = input.idempotencyKey || fingerprint(input);
  if (lessons.has(id)) return lessons.get(id)!;
  if (input.contradictoryEvidence && input.contradictoryEvidence.length > 0 && input.confidence > 0.5) {
    throw new Error('Contradictory evidence prevents validation');
  }
  if (input.confidence === undefined || input.confidence < 0.3) {
    throw new Error('Insufficient evidence for validation');
  }
  const lesson: T.ValidatedLesson = {
    id,
    lessonId: input.lessonId || id,
    patternId: input.patternId,
    lessonContent: input.lessonContent || '',
    evidenceRefs: input.evidenceRefs || [],
    confidence: input.confidence,
    affectedDomains: input.affectedDomains || [],
    limitations: input.limitations || [],
    applicabilityConstraints: input.applicabilityConstraints || [],
    state: 'VALIDATED',
    idempotencyKey: id,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
  lessons.set(id, lesson);
  return lesson;
}

export function proposeImprovement(input: any): T.ImprovementCandidate {
  const id = input.idempotencyKey || fingerprint(input);
  if (candidates.has(id)) return candidates.get(id)!;
  const candidate: T.ImprovementCandidate = {
    id,
    candidateId: input.candidateId || id,
    lessonId: input.lessonId,
    description: input.description || '',
    target: input.target,
    riskLevel: input.riskLevel || 'LOW',
    status: 'PROPOSED',
    idempotencyKey: id,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
  candidates.set(id, candidate);
  return candidate;
}

export function assessAdaptationRisk(input: any): T.RiskLevel {
  let score = 0;
  if (input.productionImpact) score += input.productionImpact;
  if (input.blastRadius === 'CRITICAL') score += 5;
  if (input.blastRadius === 'HIGH') score += 3;
  if (input.reversibility === 'LOW') score += 2;
  if (input.affectedEnvironments && input.affectedEnvironments.includes('production')) score += 3;
  if (score >= 10) return 'CRITICAL';
  if (score >= 6) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  return 'LOW';
}

export function evaluateGovernance(risk: T.RiskLevel, approvalRequired?: boolean): { decision: 'ALLOW'|'REQUIRE_APPROVAL'|'DENY'; approvalRequired: boolean } {
  if (risk === 'CRITICAL' || risk === 'HIGH') {
    return { decision: 'REQUIRE_APPROVAL', approvalRequired: true };
  }
  if (approvalRequired) {
    return { decision: 'REQUIRE_APPROVAL', approvalRequired: true };
  }
  return { decision: 'ALLOW', approvalRequired: false };
}

export function applyAuthorizedAdaptation(proposal: T.AdaptationProposal, approvalGranted: boolean): { status: string } {
  if (proposal.approvalRequired && !approvalGranted) {
    return { status: 'APPROVAL_REQUIRED' };
  }
  return { status: 'APPLIED' };
}

export function verifyAdaptation(proposalId: string, expectedOutcome: string, actualOutcome: string): { status: string; verified: boolean } {
  return { status: 'VERIFIED', verified: expectedOutcome === actualOutcome };
}

export function rollbackAdaptation(proposalId: string): { status: string } {
  return { status: 'ROLLED_BACK' };
}

export function replayLearning(input: any): { replayed: boolean; divergenceDetected: boolean; result: any } {
  const first = ingestObservation(input);
  const second = ingestObservation(input);
  return { replayed: true, divergenceDetected: first.observationId !== second.observationId, result: second };
}

export function generateEvidence(sourceId: string, evidenceType: string, content: string): { evidenceId: string; contentHash: string } {
  const id = randomUUID();
  const contentHash = hash(content);
  evidences.set(id, { id, evidenceId: id, contentHash, content, source: sourceId, createdAt: new Date().toISOString() });
  return { evidenceId: id, contentHash };
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
