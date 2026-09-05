export type ArbitrationDecision = 'ALLOW' | 'DENY' | 'HOLD' | 'REVIEW';

export interface ArbitrationInput {
  conflicts: string[];
  negativeHistoricalOutcomes: boolean;
  resourceConflict: boolean;
  policyConflict: boolean;
  rolloutConflict: boolean;
  incompatibleChanges: boolean;
  hardConstraintViolation: boolean;
}

export function arbitrateStrategy(input: ArbitrationInput): ArbitrationDecision {
  if (input.hardConstraintViolation || input.incompatibleChanges) return 'DENY';
  if (input.conflicts.length > 0 || input.policyConflict || input.rolloutConflict) return 'DENY';
  if (input.resourceConflict) return 'HOLD';
  if (input.negativeHistoricalOutcomes) return 'REVIEW';
  return 'ALLOW';
}
