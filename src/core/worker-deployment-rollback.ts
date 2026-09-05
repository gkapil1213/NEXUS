export interface DeploymentRollbackInput {
  failedReleaseId: string;
  previousReleaseId: string;
  rollbackAvailable: boolean;
  safetyApproved: boolean;
  governanceApproved: boolean;
  duplicateRollback: boolean;
  verificationSucceeded: boolean;
}

export function evaluateDeploymentRollback(input: DeploymentRollbackInput): { status: 'ROLLED_BACK' | 'BLOCKED' | 'FAILED' } {
  if (input.duplicateRollback) return { status: 'BLOCKED' };
  if (!input.rollbackAvailable) return { status: 'BLOCKED' };
  if (!input.safetyApproved || !input.governanceApproved) return { status: 'BLOCKED' };
  if (!input.verificationSucceeded) return { status: 'FAILED' };
  return { status: 'ROLLED_BACK' };
}
