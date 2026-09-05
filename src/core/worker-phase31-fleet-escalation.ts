export type EscalationLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export function determineEscalation(severity: string, productionImpact: boolean, blastRadius: string, securityRisk: boolean, repeatedFailure: boolean, rollbackFailed: boolean): EscalationLevel {
  if (severity === 'CRITICAL' || rollbackFailed || (repeatedFailure && productionImpact)) return 'CRITICAL';
  if (securityRisk || (productionImpact && blastRadius === 'CRITICAL')) return 'HIGH';
  if (blastRadius === 'HIGH' || repeatedFailure) return 'MEDIUM';
  return 'NONE';
}
