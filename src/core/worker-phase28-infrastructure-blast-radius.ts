export function calculateInfrastructureBlastRadius(dependentResources: number, affectedWorkloads: number, networkChange: boolean, databaseChange: boolean): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  let score = dependentResources + affectedWorkloads;
  if (networkChange) score += 3;
  if (databaseChange) score += 3;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
