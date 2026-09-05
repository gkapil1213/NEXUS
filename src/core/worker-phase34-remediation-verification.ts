export function verifyRemediation(expectedState: boolean, actualState: boolean, policyState: boolean): 'VERIFIED' | 'FAILED' | 'UNKNOWN' {
  if (!expectedState || !actualState || !policyState) return 'FAILED';
  return 'VERIFIED';
}
