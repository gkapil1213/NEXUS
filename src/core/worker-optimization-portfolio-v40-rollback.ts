export type PortfolioRollbackStatus = 'ROLLED_BACK' | 'ROLLBACK_BLOCKED' | 'ROLLBACK_FAILED';

export interface RollbackInput {
  portfolioId: string;
  rollbackTargetVersion: number;
  duplicateRollback: boolean;
  rollbackAuthorized: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  rollbackAvailable: boolean;
  verificationSucceeded: boolean;
}

export function evaluatePortfolioRollback(input: RollbackInput): PortfolioRollbackStatus {
  if (input.duplicateRollback) return 'ROLLBACK_BLOCKED';
  if (!input.rollbackAuthorized || !input.rollbackAvailable) return 'ROLLBACK_BLOCKED';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'ROLLBACK_BLOCKED';
  if (!input.verificationSucceeded) return 'ROLLBACK_FAILED';
  return 'ROLLED_BACK';
}
