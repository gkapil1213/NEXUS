export type StagnationStatus = 'NONE' | 'WATCH' | 'STAGNANT' | 'CRITICAL';

export interface StagnationInput {
  improvementCount: number;
  repeatedCandidates: number;
  repeatedFailures: number;
  excessiveRetirement: boolean;
  stableButSuboptimal: boolean;
  convergenceWithoutProgress: boolean;
  evidence: string[];
}

export function detectStagnation(input: StagnationInput): StagnationStatus {
  if (input.convergenceWithoutProgress || input.repeatedFailures > 5 || input.excessiveRetirement) return 'CRITICAL';
  if (input.improvementCount === 0 && input.repeatedCandidates > 3) return 'STAGNANT';
  if (input.stableButSuboptimal) return 'WATCH';
  if (input.repeatedCandidates > 0 || input.repeatedFailures > 0) return 'WATCH';
  return 'NONE';
}
