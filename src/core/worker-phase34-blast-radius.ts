export function calculateAccessBlastRadius(affectedIdentities: number, affectedRoles: number, affectedPermissions: number, affectedResources: number, environments: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const score = affectedIdentities + affectedRoles + affectedPermissions + affectedResources + environments;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
