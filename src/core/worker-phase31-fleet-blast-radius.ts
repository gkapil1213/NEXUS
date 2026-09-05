export function calculateFleetBlastRadius(directlyAffected: number, indirectlyAffected: number, protectedResources: number, criticalDependencies: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const score = directlyAffected + indirectlyAffected + protectedResources * 2 + criticalDependencies * 2;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
