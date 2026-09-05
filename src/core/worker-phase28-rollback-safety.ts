export interface RollbackSafetyInput { previousStateExists: boolean; rollbackTargetAvailable: boolean; governanceAllows: boolean; blastRadiusAcceptable: boolean; }
export function evaluateRollbackSafety(input: RollbackSafetyInput): { allowed: boolean; reason: string } {
  if (!input.previousStateExists) return { allowed: false, reason: 'previous state missing' };
  if (!input.rollbackTargetAvailable) return { allowed: false, reason: 'target unavailable' };
  if (!input.governanceAllows) return { allowed: false, reason: 'governance denies rollback' };
  if (!input.blastRadiusAcceptable) return { allowed: false, reason: 'blast radius too high' };
  return { allowed: true, reason: 'OK' };
}
