export type ArbitrationDecision = 'ACCEPT' | 'DEFER' | 'REJECT' | 'PAUSE' | 'REQUIRE_EVIDENCE' | 'REQUIRE_HUMAN_APPROVAL';

export interface ArbitrationInput {
  candidateRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  expectedBenefit: number;
  hardConstraintViolation: boolean;
  activeIncident: boolean;
  productionFreeze: boolean;
  insufficientEvidence: boolean;
  resourceOvercommit: boolean;
  conflictDetected: boolean;
}

export function arbitrateCandidate(input: ArbitrationInput): ArbitrationDecision {
  if (input.hardConstraintViolation || input.productionFreeze) return 'REJECT';
  if (input.activeIncident) return 'PAUSE';
  if (input.candidateRisk === 'CRITICAL' || input.candidateRisk === 'UNKNOWN') return 'REQUIRE_HUMAN_APPROVAL';
  if (input.insufficientEvidence || input.confidence === 'LOW' || input.confidence === 'UNKNOWN') return 'REQUIRE_EVIDENCE';
  if (input.resourceOvercommit || input.conflictDetected) return 'DEFER';
  if (input.expectedBenefit <= 0) return 'REJECT';
  if (input.candidateRisk === 'HIGH') return 'REQUIRE_HUMAN_APPROVAL';
  return 'ACCEPT';
}
