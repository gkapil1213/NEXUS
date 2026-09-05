export type Role = 'ENGINEER' | 'SENIOR_ENGINEER' | 'SECURITY_REVIEWER' | 'RELEASE_MANAGER' | 'OPERATIONS_ADMIN' | 'GOVERNANCE_ADMIN' | 'SYSTEM_OWNER';

export interface ApprovalAuthority {
  actorId: string;
  role: Role;
  tenantId: string;
}

export function isRoleAuthorized(actor: ApprovalAuthority, requiredRoles: Role[]): boolean {
  return requiredRoles.includes(actor.role);
}
