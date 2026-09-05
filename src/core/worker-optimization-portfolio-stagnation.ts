export type StagnationStatus = 'NONE' | 'WATCH' | 'STAGNANT' | 'CRITICAL';

export interface StagnationInput {
  improvementCount: number;
  repeatedFailedExperiments: number;
  explorationRate: number;
  exploitationRate: number;
  candidateDiversity: number;
  learningTransferCount: number;
  confidenceTrend: number; // negative means decreasing
}

export function detectPortfolioStagnation(input: StagnationInput): StagnationStatus {
  if (input.candidateDiversity < 0.2 || input.confidenceTrend < -0.3) return 'CRITICAL';
  if (input.improvementCount === 0 && input.repeatedFailedExperiments > 3) return 'STAGNANT';
  if (input.explorationRate < 0.2 || input.learningTransferCount === 0) return 'WATCH';
  return 'NONE';
}
