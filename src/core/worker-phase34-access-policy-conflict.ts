export type PolicyDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL' | 'BLOCKED' | 'UNKNOWN';

export function resolveAccessPolicyConflict(decisions: PolicyDecision[]): PolicyDecision {
  const precedence: PolicyDecision[] = ['BLOCKED', 'DENY', 'REQUIRES_APPROVAL', 'UNKNOWN', 'ALLOW'];
  for (const d of precedence) if (decisions.includes(d)) return d;
  return 'ALLOW';
}
