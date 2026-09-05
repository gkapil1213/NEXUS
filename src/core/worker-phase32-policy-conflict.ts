export type Decision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'REQUIRE_EXCEPTION' | 'BLOCK' | 'UNKNOWN';

export function resolvePolicyConflict(decisions: Decision[]): Decision {
  const precedence: Decision[] = ['BLOCK', 'DENY', 'REQUIRE_EXCEPTION', 'REQUIRE_APPROVAL', 'UNKNOWN', 'ALLOW'];
  for (const d of precedence) {
    if (decisions.includes(d)) return d;
  }
  return 'ALLOW';
}
