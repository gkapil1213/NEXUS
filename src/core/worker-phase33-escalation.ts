export type EscalationLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export function determineEscalation(severity: string, blastRadius: string, environment: string, criticality: string, repeatedFailure: boolean): EscalationLevel {
  if (severity === 'CRITICAL' || repeatedFailure) return 'CRITICAL';
  if (environment === 'production' && blastRadius === 'HIGH') return 'HIGH';
  if (criticality === 'HIGH') return 'MEDIUM';
  return 'NONE';
}
