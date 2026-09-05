import { randomUUID } from 'crypto';

export type AdaptationDecision = 'CONTINUE' | 'ADAPT' | 'PAUSE' | 'ROLLBACK' | 'RETIRE' | 'PROMOTE' | 'HOLD';

export interface AdaptationInput {
  outcome: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'NEUTRAL' | 'FAILURE' | 'REGRESSION' | 'INCONCLUSIVE';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  driftSeverity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  resourceBudgetExceeded: boolean;
  safetyViolation: boolean;
}

export function determineAdaptation(input: AdaptationInput): AdaptationDecision {
  if (input.safetyViolation || input.resourceBudgetExceeded) return 'ROLLBACK';
  if (input.driftSeverity === 'CRITICAL' || input.driftSeverity === 'HIGH') return 'ROLLBACK';
  if (input.outcome === 'REGRESSION') return 'ROLLBACK';
  if (input.outcome === 'SUCCESS' && input.driftSeverity === 'NONE') return 'PROMOTE';
  if (input.outcome === 'PARTIAL_SUCCESS') return 'CONTINUE';
  if (input.outcome === 'INCONCLUSIVE' || input.confidence === 'LOW') return 'HOLD';
  return 'ADAPT';
}