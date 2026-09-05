export type EscalationLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export function determineEscalation(severity: string, duration: number, customerImpact: boolean, criticality: string, remediationFailed: boolean, rollbackFailed: boolean): EscalationLevel {
  if (severity === 'CRITICAL' || rollbackFailed || (remediationFailed && criticality === 'CRITICAL')) return 'CRITICAL';
  if (severity === 'HIGH' && customerImpact) return 'HIGH';
  if (duration > 3600000 || severity === 'MEDIUM') return 'MEDIUM';
  return 'NONE';
}
