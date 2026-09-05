export type RollbackStatus = 'ROLLBACK_REQUESTED' | 'ROLLBACK_APPROVED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'ROLLBACK_FAILED' | 'ROLLBACK_BLOCKED';

export interface RollbackInput {
  experimentId: string;
  populationId: string;
  targetPopulationVersion: number;
  duplicateRollback: boolean;
  rollbackAuthorized: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  rollbackAvailable: boolean;
  verificationSucceeded: boolean;
}

export function evaluateExperimentRollback(input: RollbackInput): RollbackStatus {
  if (input.duplicateRollback) return 'ROLLBACK_BLOCKED';
  if (!input.rollbackAuthorized || !input.rollbackAvailable) return 'ROLLBACK_BLOCKED';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'ROLLBACK_BLOCKED';
  if (!input.verificationSucceeded) return 'ROLLBACK_FAILED';
  return 'ROLLED_BACK';
}
