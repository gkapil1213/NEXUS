export type GovernanceDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL' | 'EXPIRED' | 'REVOKED' | 'STALE' | 'CONFLICT' | 'UNAVAILABLE';

export interface GovernanceDecisionInput {
  requestFingerprint: string;
  policy: { status: string; decision: 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL' | 'UNKNOWN' };
  riskLevel: string;
  approval?: { status: string; valid: boolean; reason?: string };
  emergency?: boolean;
}

export function makeGovernanceDecision(input: GovernanceDecisionInput): GovernanceDecision {
  if (input.policy.status !== 'ACTIVE') return 'UNAVAILABLE';
  if (input.policy.decision === 'DENY') return 'DENY';
  if (input.policy.decision === 'REQUIRES_APPROVAL') {
    if (!input.approval || !input.approval.valid) return 'REQUIRES_APPROVAL';
    return 'ALLOW';
  }
  // policy ALLOW
  if (input.approval && !input.approval.valid) return 'REQUIRES_APPROVAL';
  return 'ALLOW';
}
