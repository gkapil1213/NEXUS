export type ExplorationDecision = 'EXPLORE' | 'EXPLOIT' | 'PRESERVE' | 'REDUCE_MUTATION' | 'INCREASE_CHALLENGER_EVALUATION' | 'INITIATE_RECOVERY';

export interface ExplorationGovernanceInput {
  populationHealth: 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'STAGNANT' | 'FRAGILE' | 'RECOVERY_REQUIRED';
  explorationPressure: number;
  exploitationPressure: number;
  stagnationScore: number;
  diversityScore: number;
  governanceAllowed: boolean;
  resourceAvailable: boolean;
}

export function decideExplorationGovernance(input: ExplorationGovernanceInput): ExplorationDecision {
  if (!input.governanceAllowed) return 'PRESERVE';
  if (input.populationHealth === 'RECOVERY_REQUIRED' || input.populationHealth === 'FRAGILE') return 'INITIATE_RECOVERY';
  if (input.stagnationScore > 0.7) return 'EXPLORE';
  if (input.diversityScore < 0.3) return 'INCREASE_CHALLENGER_EVALUATION';
  if (input.explorationPressure > input.exploitationPressure && input.resourceAvailable) return 'EXPLORE';
  if (input.exploitationPressure > 0.6 && input.populationHealth === 'HEALTHY') return 'EXPLOIT';
  return 'PRESERVE';
}
