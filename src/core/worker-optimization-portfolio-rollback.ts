export type RollbackScope = 'EXPERIMENT_ROLLBACK' | 'CANDIDATE_ROLLBACK' | 'POLICY_ROLLBACK' | 'PORTFOLIO_ROLLBACK';

export interface PortfolioRollbackInput {
  scope: RollbackScope;
  tenantId: string;
  portfolioId: string;
  currentVersion: string;
  targetKnownGoodVersion: string;
  duplicateRollback: boolean;
  rollbackAuthorized: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  rollbackAvailable: boolean;
}

export type RollbackDecision = 'ALLOWED' | 'DENIED' | 'DEFERRED';

export function evaluatePortfolioRollback(input: PortfolioRollbackInput): RollbackDecision {
  if (input.duplicateRollback) return 'DEFERRED';
  if (!input.rollbackAuthorized || !input.rollbackAvailable) return 'DENIED';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'DENIED';
  return 'ALLOWED';
}
