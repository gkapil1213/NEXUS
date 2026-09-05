export type RollbackDecision = 'ALLOWED' | 'DENIED' | 'DEFERRED';

export interface StrategyRollbackInput {
  strategyId: string;
  tenantId: string;
  duplicateRollback: boolean;
  rollbackAuthorized: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  rollbackAvailable: boolean;
  dependencyOrderValid: boolean;
}

export function evaluateStrategyRollback(input: StrategyRollbackInput): RollbackDecision {
  if (input.duplicateRollback) return 'DEFERRED';
  if (!input.rollbackAuthorized || !input.rollbackAvailable) return 'DENIED';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'DENIED';
  if (!input.dependencyOrderValid) return 'DENIED';
  return 'ALLOWED';
}
