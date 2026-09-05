export function calculateBlastRadius(affectedResources: number, dependentResources: number, environments: number, fleets: number, securityImpact: number, complianceImpact: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const score = affectedResources + dependentResources + environments + fleets + securityImpact * 2 + complianceImpact * 2;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
