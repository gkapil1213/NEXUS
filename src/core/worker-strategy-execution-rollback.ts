export type RollbackStatus = 'ROLLBACK_REQUESTED' | 'ROLLBACK_APPROVED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'ROLLBACK_FAILED' | 'ROLLBACK_BLOCKED';

export interface RollbackInput {
  strategyId: string;
  executionId: string;
  rollbackTarget: string;
  eligible: boolean;
  authorized: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  providerAvailable: boolean;
  verificationSucceeded: boolean;
}

export function requestRollback(input: RollbackInput): RollbackStatus {
  if (!input.eligible || !input.authorized) return 'ROLLBACK_BLOCKED';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'ROLLBACK_BLOCKED';
  if (!input.providerAvailable) return 'ROLLBACK_BLOCKED';
  if (!input.verificationSucceeded) return 'ROLLBACK_FAILED';
  return 'ROLLED_BACK';
}