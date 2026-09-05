export function calculateGovernanceBlastRadius(affectedResources: number, affectedEnvironments: number, affectedFleets: number, affectedServices: number, availabilityImpact: number, securityImpact: number, dataImpact: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const score = affectedResources + affectedEnvironments + affectedFleets + affectedServices + availabilityImpact * 2 + securityImpact * 2 + dataImpact * 2;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
