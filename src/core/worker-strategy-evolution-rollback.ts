export type EvolutionRollbackStatus = 'REQUESTED' | 'APPROVED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'ROLLBACK_FAILED' | 'BLOCKED';

export interface EvolutionRollbackInput {
  candidateId: string;
  parentGenerationId: string;
  reason: string;
  eligible: boolean;
  authorized: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  rollbackAvailable: boolean;
  verificationSucceeded: boolean;
}

export function evaluateEvolutionRollback(input: EvolutionRollbackInput): EvolutionRollbackStatus {
  if (!input.eligible || !input.authorized) return 'BLOCKED';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'BLOCKED';
  if (!input.rollbackAvailable) return 'BLOCKED';
  if (!input.verificationSucceeded) return 'ROLLBACK_FAILED';
  return 'ROLLED_BACK';
}
