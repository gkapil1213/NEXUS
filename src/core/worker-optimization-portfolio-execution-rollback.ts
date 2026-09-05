export interface ExecutionRollbackInput {
  executionId: string;
  portfolioId: string;
  targetVersion: number;
  duplicateRollback: boolean;
  rollbackAuthorized: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  rollbackAvailable: boolean;
  verificationSucceeded: boolean;
}

export function evaluateExecutionRollback(input: ExecutionRollbackInput): { status: 'ROLLED_BACK' | 'ROLLBACK_BLOCKED' | 'ROLLBACK_FAILED' } {
  if (input.duplicateRollback) return { status: 'ROLLBACK_BLOCKED' };
  if (!input.rollbackAuthorized || !input.rollbackAvailable) return { status: 'ROLLBACK_BLOCKED' };
  if (!input.governanceAllowed || !input.safetyAllowed) return { status: 'ROLLBACK_BLOCKED' };
  if (!input.verificationSucceeded) return { status: 'ROLLBACK_FAILED' };
  return { status: 'ROLLED_BACK' };
}
