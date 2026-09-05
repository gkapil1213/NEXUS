export interface PrivilegeRiskInput {
  wildcardPermissions: boolean;
  adminPermissions: boolean;
  crossEnvironmentAccess: boolean;
  productionAccess: boolean;
  lowTrustIdentity: boolean;
  dormantPrivilegedIdentity: boolean;
  privilegeEscalationPath: boolean;
}

export function assessPrivilegeRisk(input: PrivilegeRiskInput): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  let score = 0;
  if (input.wildcardPermissions) score += 3;
  if (input.adminPermissions) score += 3;
  if (input.crossEnvironmentAccess) score += 2;
  if (input.productionAccess) score += 2;
  if (input.lowTrustIdentity) score += 2;
  if (input.dormantPrivilegedIdentity) score += 2;
  if (input.privilegeEscalationPath) score += 3;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
