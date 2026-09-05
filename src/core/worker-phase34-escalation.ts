export type EscalationLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export function determineEscalation(severity: string, blastRadius: string, criticality: string, repeatedFailure: boolean): EscalationLevel {
  if (severity === 'CRITICAL' || repeatedFailure) return 'CRITICAL';
  if (blastRadius === 'HIGH') return 'HIGH';
  if (criticality === 'HIGH') return 'MEDIUM';
  return 'LOW';
}
