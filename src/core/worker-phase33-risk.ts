export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export function assessRisk(input: { criticality: string; blastRadius: string; securitySeverity: string; policySeverity: string; unknownState: boolean }): RiskLevel {
  if (input.unknownState) return 'UNKNOWN';
  if (input.criticality === 'CRITICAL' || input.securitySeverity === 'CRITICAL') return 'CRITICAL';
  if (input.blastRadius === 'HIGH' || input.blastRadius === 'CRITICAL') return 'HIGH';
  if (input.policySeverity === 'HIGH') return 'MEDIUM';
  return 'LOW';
}
