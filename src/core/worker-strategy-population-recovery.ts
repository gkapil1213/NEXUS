export type RecoveryAction = 'PRESERVE_CHAMPION' | 'STOP_UNSAFE_ROLLOUT' | 'RESTORE_STABLE_STRATEGIES' | 'REDUCE_EVOLUTION_PRESSURE' | 'SUSPEND_RISKY_MUTATIONS' | 'REQUIRE_GOVERNANCE';

export interface RecoveryInput {
  populationHealth: 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'STAGNANT' | 'FRAGILE' | 'RECOVERY_REQUIRED';
  unsafeRolloutActive: boolean;
  stableStrategyAvailable: boolean;
  governanceRequired: boolean;
}

export function initiateRecovery(input: RecoveryInput): RecoveryAction[] {
  const actions: RecoveryAction[] = [];
  if (input.populationHealth === 'FRAGILE' || input.populationHealth === 'RECOVERY_REQUIRED') {
    actions.push('PRESERVE_CHAMPION');
    if (input.unsafeRolloutActive) actions.push('STOP_UNSAFE_ROLLOUT');
    if (input.stableStrategyAvailable) actions.push('RESTORE_STABLE_STRATEGIES');
    actions.push('REDUCE_EVOLUTION_PRESSURE');
    if (input.governanceRequired) actions.push('REQUIRE_GOVERNANCE');
  }
  return actions;
}
