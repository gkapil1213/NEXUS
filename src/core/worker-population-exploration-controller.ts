export type ExplorationMode = 'EXPLORE' | 'EXPLOIT' | 'BALANCE' | 'PAUSE';

export interface ExplorationControllerInput {
  diversity: number;
  uncertainty: number;
  recentImprovement: number;
  stagnation: number;
  experimentSuccessRate: number;
  failureRate: number;
  confidence: number;
  resourceConsumption: number;
  fatigue: number;
  unresolvedExperiments: number;
  safetyHealthy: boolean;
}

export function decideExplorationMode(input: ExplorationControllerInput): ExplorationMode {
  if (!input.safetyHealthy || input.resourceConsumption > 0.9 || input.fatigue > 0.8) return 'PAUSE';
  if (input.stagnation > 0.7 || input.uncertainty > 0.7) return 'EXPLORE';
  if (input.experimentSuccessRate > 0.7 && input.confidence > 0.7 && input.recentImprovement > 0) return 'EXPLOIT';
  if (input.diversity < 0.3) return 'EXPLORE';
  return 'BALANCE';
}
