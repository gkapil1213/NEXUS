export interface InfrastructureSafetyInput {
  deleteCriticalResource: boolean;
  reduceBelowMinimum: boolean;
  disableRedundancy: boolean;
  modifyProtectedResource: boolean;
  criticalIncidentActive: boolean;
  securitySensitive: boolean;
  rollbackRequiredButMissing: boolean;
}

export function evaluateInfrastructureSafety(input: InfrastructureSafetyInput): { allowed: boolean; reason: string } {
  if (input.deleteCriticalResource) return { allowed: false, reason: 'critical resource deletion blocked' };
  if (input.reduceBelowMinimum) return { allowed: false, reason: 'below minimum capacity' };
  if (input.disableRedundancy) return { allowed: false, reason: 'redundancy disabled' };
  if (input.modifyProtectedResource) return { allowed: false, reason: 'protected resource' };
  if (input.criticalIncidentActive) return { allowed: false, reason: 'critical incident active' };
  if (input.securitySensitive) return { allowed: false, reason: 'security sensitive' };
  if (input.rollbackRequiredButMissing) return { allowed: false, reason: 'rollback required but missing' };
  return { allowed: true, reason: 'OK' };
}
