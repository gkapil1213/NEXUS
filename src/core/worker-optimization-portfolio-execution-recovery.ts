export interface RecoveryInput {
  executionFailed: boolean;
  partialExecution: boolean;
  timeout: boolean;
  resourceExhaustion: boolean;
  degradedPortfolio: boolean;
  strategyFailure: boolean;
  governanceInterrupted: boolean;
}

export function decideRecoveryAction(input: RecoveryInput): 'PAUSE' | 'ROLLBACK' | 'THROTTLE' | 'REALLOCATE' | 'NONE' {
  if (input.governanceInterrupted) return 'PAUSE';
  if (input.executionFailed || input.timeout || input.resourceExhaustion) return 'ROLLBACK';
  if (input.degradedPortfolio) return 'THROTTLE';
  if (input.strategyFailure) return 'REALLOCATE';
  if (input.partialExecution) return 'NONE';
  return 'NONE';
}
