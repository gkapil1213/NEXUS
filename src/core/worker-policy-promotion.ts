export type PromotionDecision = 'PROMOTED' | 'DENIED' | 'DEFERRED';

export interface PromotionInput {
  tenantId: string;
  policyId: string;
  currentVersion: string;
  proposedVersion: string;
  verificationResult: string; // from verification module
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  governanceDecision: string;
  safetyDecision: string;
  activeIncident: boolean;
  stableObservation: boolean;
  conflictingNewerPolicy: boolean;
  policyStillCurrent: boolean;
  cooldownSatisfied: boolean;
}

export function evaluatePromotion(input: PromotionInput): PromotionDecision {
  if (input.activeIncident || !input.cooldownSatisfied) return 'DENIED';
  if (!input.policyStillCurrent || input.conflictingNewerPolicy) return 'DENIED';
  if (!input.stableObservation) return 'DEFERRED';
  if (input.governanceDecision !== 'ALLOW' || input.safetyDecision !== 'ALLOW') return 'DENIED';
  if (input.confidence === 'LOW' || input.confidence === 'UNKNOWN') return 'DEFERRED';
  if (input.verificationResult === 'VERIFIED_REGRESSION' || input.verificationResult === 'CONFLICTED') return 'DENIED';
  if (input.verificationResult === 'VERIFIED_IMPROVEMENT') return 'PROMOTED';
  if (input.verificationResult === 'NO_SIGNIFICANT_CHANGE') return 'DEFERRED';
  return 'DEFERRED';
}
