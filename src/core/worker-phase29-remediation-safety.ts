export interface RemediationSafetyInput {
  productionDatabase: boolean;
  primaryDatabase: boolean;
  criticalSchema: boolean;
  protectedResource: boolean;
  destructiveOperation: boolean;
  highBlastRadius: boolean;
  rollbackMissing: boolean;
}

export function evaluateRemediationSafety(input: RemediationSafetyInput): { allowed: boolean; reason: string } {
  if (input.protectedResource) return { allowed: false, reason: 'protected resource' };
  if (input.destructiveOperation && !input.rollbackMissing) return { allowed: false, reason: 'destructive operation without rollback' };
  if (input.productionDatabase && input.highBlastRadius) return { allowed: false, reason: 'high blast radius in production' };
  if (input.primaryDatabase && input.criticalSchema) return { allowed: false, reason: 'primary critical schema' };
  return { allowed: true, reason: 'OK' };
}
