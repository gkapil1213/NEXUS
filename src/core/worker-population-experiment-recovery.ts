export interface RecoveryInput {
  stagnationScore: number;
  fatigueLevel: 'NONE' | 'LOW' | 'MODERATE' | 'HIGH' | 'THROTTLED';
  diversityScore: number;
  safetyHealthy: boolean;
  governanceAllowed: boolean;
  resourceAvailable: boolean;
}

export function decideRecoveryAction(input: RecoveryInput): 'INCREASE_EXPLORATION' | 'PAUSE_EXPERIMENTS' | 'REVISIT_PROMISING' | 'DIVERSIFY' | 'NONE' {
  if (!input.safetyHealthy || !input.governanceAllowed || !input.resourceAvailable) return 'PAUSE_EXPERIMENTS';
  if (input.stagnationScore > 0.7 && input.diversityScore < 0.4) return 'DIVERSIFY';
  if (input.fatigueLevel === 'HIGH' || input.fatigueLevel === 'THROTTLED') return 'PAUSE_EXPERIMENTS';
  if (input.stagnationScore > 0.5) return 'INCREASE_EXPLORATION';
  return 'NONE';
}
