export type GovernanceDecision = 'ALLOW' | 'REQUIRES_APPROVAL' | 'DENY' | 'FREEZE';

export function governIdentityAccess(input: { risk: string; protectedResource: boolean; production: boolean; approvalRequired: boolean }): GovernanceDecision {
  if (input.protectedResource) return 'DENY';
  if (input.risk === 'CRITICAL') return 'REQUIRES_APPROVAL';
  if (input.production && input.risk !== 'LOW') return 'REQUIRES_APPROVAL';
  return 'ALLOW';
}
