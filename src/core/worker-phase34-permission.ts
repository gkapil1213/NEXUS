export interface Permission {
  permissionId: string;
  provider: string;
  resource: string;
  resourceType: string;
  action: string;
  scope: string;
  environment: string;
  conditions: Record<string, unknown>;
  sensitivity: string;
  privilegeLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function createPermission(input: Permission): Permission {
  return input;
}

export function classifyPermissionRisk(input: Permission): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (input.action === '*' || input.resource === '*') return 'CRITICAL';
  if (input.privilegeLevel === 'CRITICAL') return 'CRITICAL';
  if (input.privilegeLevel === 'HIGH') return 'HIGH';
  if (input.privilegeLevel === 'MEDIUM') return 'MEDIUM';
  return 'LOW';
}
