export type EvolutionSafetyDecision = 'ALLOW' | 'DENY' | 'PAUSE';

export interface EvolutionSafetyInput {
  parentStrategyExists: boolean;
  parentGenerationValid: boolean;
  duplicateCandidate: boolean;
  validLineage: boolean;
  validChangeSet: boolean;
  constraintsPass: boolean;
  safetyChecksPass: boolean;
  confidenceThresholdMet: boolean;
  regressionChecksPass: boolean;
  shadowEvaluationPassed: boolean;
  resourceBudgetAvailable: boolean;
  governancePassed: boolean;
  rollbackCapabilityExists: boolean;
}

export function evaluateEvolutionSafety(input: EvolutionSafetyInput): EvolutionSafetyDecision {
  if (!input.parentStrategyExists || !input.parentGenerationValid || !input.validLineage) return 'DENY';
  if (input.duplicateCandidate || !input.validChangeSet) return 'DENY';
  if (!input.constraintsPass || !input.safetyChecksPass) return 'DENY';
  if (!input.confidenceThresholdMet || !input.regressionChecksPass) return 'DENY';
  if (!input.shadowEvaluationPassed) return 'PAUSE';
  if (!input.resourceBudgetAvailable || !input.governancePassed) return 'DENY';
  if (!input.rollbackCapabilityExists) return 'DENY';
  return 'ALLOW';
}
