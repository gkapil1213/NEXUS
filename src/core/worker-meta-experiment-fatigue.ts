export type FatigueLevel = 'NONE' | 'LOW' | 'MODERATE' | 'HIGH' | 'THROTTLED';

export interface MetaFatigueInput {
  experimentFrequency: number;
  repeatedMethods: number;
  repeatedCandidates: number;
  resourceUtilization: number;
  repeatedFailures: number;
}

export function evaluateMetaFatigue(input: MetaFatigueInput): FatigueLevel {
  const score = input.experimentFrequency * 0.2 + input.repeatedMethods * 0.2 + input.repeatedCandidates * 0.2 + input.resourceUtilization * 0.2 + input.repeatedFailures * 0.2;
  if (score >= 1.5) return 'THROTTLED';
  if (score >= 1.2) return 'HIGH';
  if (score >= 0.8) return 'MODERATE';
  if (score >= 0.4) return 'LOW';
  return 'NONE';
}
