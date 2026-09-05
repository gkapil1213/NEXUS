export type PopulationRollbackDecision = 'ALLOWED' | 'DENIED' | 'DEFERRED';

export interface PopulationRollbackInput {
  populationId: string;
  targetVersion: number;
  duplicateRollback: boolean;
  rollbackAuthorized: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  rollbackAvailable: boolean;
  verificationSucceeded: boolean;
}

export function evaluatePopulationRollback(input: PopulationRollbackInput): PopulationRollbackDecision {
  if (input.duplicateRollback) return 'DEFERRED';
  if (!input.rollbackAuthorized || !input.rollbackAvailable) return 'DENIED';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'DENIED';
  if (!input.verificationSucceeded) return 'DENIED';
  return 'ALLOWED';
}
