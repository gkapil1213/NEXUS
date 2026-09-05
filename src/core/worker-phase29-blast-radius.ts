export function calculateBlastRadius(dependentResources: number, protectedResources: number, production: boolean, dataLossPotential: number, availabilityImpact: number, rollbackDifficulty: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  let score = dependentResources + protectedResources * 2 + dataLossPotential * 2 + availabilityImpact * 2 + rollbackDifficulty;
  if (production) score += 2;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
