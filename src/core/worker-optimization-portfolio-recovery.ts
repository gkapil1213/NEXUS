export interface RecoveryInput {
  portfolioHealth: 'HEALTHY' | 'DEGRADED' | 'UNSTABLE' | 'STAGNANT' | 'UNSAFE';
  safetyHealthy: boolean;
  governanceAllowed: boolean;
  budgetAvailable: boolean;
}

export function decideRecoveryAction(input: RecoveryInput): string {
  if (!input.safetyHealthy || !input.governanceAllowed || !input.budgetAvailable) return 'PAUSE_EXPERIMENTS';
  if (input.portfolioHealth === 'UNSAFE' || input.portfolioHealth === 'DEGRADED') return 'ROLLBACK_SAFE_STATE';
  if (input.portfolioHealth === 'STAGNANT') return 'INCREASE_EXPLORATION';
  return 'NONE';
}
