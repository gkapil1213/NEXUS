export type StagnationStatus = 'NONE' | 'WATCH' | 'STAGNANT' | 'CRITICAL';

export interface MetaStagnationInput {
  neutralOutcomes: number;
  noParetoImprovement: number;
  repeatedCandidateFailures: number;
  diversityCollapse: boolean;
  repeatedRollbacks: number;
}

export function detectMetaStagnation(input: MetaStagnationInput): StagnationStatus {
  if (input.diversityCollapse || input.repeatedRollbacks > 5 || input.repeatedCandidateFailures > 5) return 'CRITICAL';
  if (input.neutralOutcomes > 5 || input.noParetoImprovement > 3) return 'STAGNANT';
  if (input.neutralOutcomes > 2) return 'WATCH';
  return 'NONE';
}
