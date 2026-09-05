export function verifyRemediation(expectedState: boolean, actualState: boolean, policyState: boolean, costState: boolean, securityState: boolean): 'VERIFIED' | 'FAILED' | 'UNKNOWN' {
  if (!expectedState || !actualState || !policyState) return 'FAILED';
  if (costState === false || securityState === false) return 'UNKNOWN';
  return 'VERIFIED';
}
