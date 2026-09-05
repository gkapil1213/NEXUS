export interface RecoverySafetyInput {
  productionRestore: boolean;
  productionFailover: boolean;
  destructiveAction: boolean;
  dataReplacement: boolean;
  targetSwitching: boolean;
  rollbackAvailable: boolean;
  approved: boolean;
}

export function evaluateRecoverySafety(input: RecoverySafetyInput): { allowed: boolean; reason: string } {
  if (input.destructiveAction && !input.rollbackAvailable) return { allowed: false, reason: 'destructive action without rollback' };
  if (input.destructiveAction && input.productionRestore) return { allowed: false, reason: 'destructive production restore blocked' };
  if ((input.productionRestore || input.productionFailover) && !input.approved) return { allowed: false, reason: 'production recovery requires approval' };
  if (input.dataReplacement && !input.rollbackAvailable) return { allowed: false, reason: 'data replacement without rollback' };
  return { allowed: true, reason: 'OK' };
}
