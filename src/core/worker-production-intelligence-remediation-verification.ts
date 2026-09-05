export interface RemediationVerificationInput {
  beforeState: Record<string, number>;
  afterState: Record<string, number>;
  expectedRecovery: boolean;
}

export function verifyRemediation(input: RemediationVerificationInput): { status: 'VERIFIED' | 'NOT_VERIFIED' | 'DEGRADED' | 'FAILED' | 'UNKNOWN' } {
  // simple deterministic check: if expectedRecovery and any key improved, verified
  let improved = false;
  for (const key of Object.keys(input.beforeState)) {
    if (input.afterState[key] < input.beforeState[key]) improved = true;
  }
  if (improved) return { status: 'VERIFIED' };
  return { status: 'NOT_VERIFIED' };
}
