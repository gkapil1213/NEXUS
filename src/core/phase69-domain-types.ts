export type ObservationStatus = 'RAW'|'VALIDATED'|'CORRELATED'|'LEARNED'|'REJECTED';
export type PatternState = 'PROPOSED'|'VALIDATING'|'VALIDATED'|'ACTIVE'|'DEPRECATED'|'REJECTED';
export type LessonState = 'PROPOSED'|'EVIDENCE_REQUIRED'|'VALIDATING'|'VALIDATED'|'REJECTED'|'SUPERSEDED';
export type CandidateState = 'PROPOSED'|'RISK_ASSESSMENT'|'GOVERNANCE_REVIEW'|'APPROVED'|'REJECTED'|'APPLIED'|'VERIFIED'|'ROLLED_BACK'|'SUPERSEDED';
export type RiskLevel = 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL';

export interface LearningObservation {
  id: string;
  observationId: string;
  sourceType: string;
  sourceId?: string;
  eventData: Record<string, unknown>;
  status: ObservationStatus;
  confidence: number;
  evidenceRefs: string[];
  correlationId?: string;
  causationId?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningCorrelation {
  id: string;
  correlationId: string;
  participantIds: string[];
  relationshipType: string;
  confidence: number;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  correlationStatus: string;
  isCausal: boolean;
  createdAt: string;
}

export interface LearnedPattern {
  id: string;
  patternId: string;
  description: string;
  inputs: Record<string, unknown>;
  observedConditions: Record<string, unknown>;
  expectedOutcome: string;
  supportingEvidence: string[];
  confidence: number;
  validationCount: number;
  failureCount: number;
  lastObservedAt?: string;
  applicabilityScope?: string;
  riskLevel: RiskLevel;
  lifecycleState: PatternState;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidatedLesson {
  id: string;
  lessonId: string;
  patternId?: string;
  lessonContent: string;
  evidenceRefs: string[];
  confidence: number;
  affectedDomains: string[];
  limitations: string[];
  applicabilityConstraints: string[];
  state: LessonState;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImprovementCandidate {
  id: string;
  candidateId: string;
  lessonId?: string;
  description: string;
  target?: string;
  riskLevel: RiskLevel;
  status: CandidateState;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdaptationProposal {
  id: string;
  proposalId: string;
  candidateId: string;
  scope?: string;
  riskLevel: RiskLevel;
  governanceDecision?: string;
  approvalRequired: boolean;
  status: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}
