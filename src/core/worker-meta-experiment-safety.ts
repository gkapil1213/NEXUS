export type SafetyDecision = 'ALLOW' | 'DENY' | 'HOLD';

export interface MetaSafetyInput {
  authorizedMethod: boolean;
  authorizedObjective: boolean;
  validCandidate: boolean;
  validPopulation: boolean;
  constraintsValid: boolean;
  budgetAvailable: boolean;
  concurrencyAvailable: boolean;
  evidencePolicyValid: boolean;
  rollbackAvailable: boolean;
  lineageValid: boolean;
  noProhibitedMutation: boolean;
  noUnsafeRegression: boolean;
}

export function evaluateMetaSafety(input: MetaSafetyInput): SafetyDecision {
  if (!input.authorizedMethod || !input.authorizedObjective || !input.validCandidate || !input.validPopulation) return 'DENY';
  if (!input.constraintsValid || !input.evidencePolicyValid || !input.lineageValid || !input.noProhibitedMutation || !input.noUnsafeRegression) return 'DENY';
  if (!input.budgetAvailable || !input.concurrencyAvailable || !input.rollbackAvailable) return 'HOLD';
  return 'ALLOW';
}
