export type FatigueLevel = 'NONE' | 'LOW' | 'MODERATE' | 'HIGH' | 'THROTTLED';

export interface FatigueInput {
  repeatedExperimentsNoLearning: number;
  repeatedCandidateFailures: number;
  experimentFrequency: number;
  populationMutationCount: number;
  redundantComparisons: number;
  resourceConsumption: number;
  unstableOutcomes: boolean;
}

export function evaluateExperimentFatigue(input: FatigueInput): FatigueLevel {
  if (input.unstableOutcomes || input.resourceConsumption > 0.9) return 'THROTTLED';
  const score = input.repeatedExperimentsNoLearning * 0.2 + input.repeatedCandidateFailures * 0.25 + input.experimentFrequency * 0.1 + input.populationMutationCount * 0.15 + input.redundantComparisons * 0.3;
  if (score >= 2) return 'THROTTLED';
  if (score >= 1.5) return 'HIGH';
  if (score >= 1) return 'MODERATE';
  if (score >= 0.5) return 'LOW';
  return 'NONE';
}
