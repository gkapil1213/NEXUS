import { AccessPolicy } from './worker-phase34-access-policy';

export type AccessDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL' | 'BLOCKED' | 'UNKNOWN';

export function evaluateAccessPolicy(policy: AccessPolicy, context: Record<string, unknown>): AccessDecision {
  const conditionMet = Object.entries(policy.conditions).every(([key, value]) => context[key] === value);
  if (policy.effect === 'DENY') return conditionMet ? 'DENY' : 'ALLOW';
  if (policy.effect === 'CONDITIONAL') return conditionMet ? 'REQUIRES_APPROVAL' : 'DENY';
  // ALLOW
  return conditionMet ? 'ALLOW' : 'BLOCKED';
}
