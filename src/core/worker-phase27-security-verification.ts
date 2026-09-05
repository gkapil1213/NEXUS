export interface VerificationInput {
  threatSignalDisappeared: boolean;
  credentialInvalid: boolean;
  artifactQuarantined: boolean;
  vulnerabilityReachable: boolean;
  deploymentRolledBack: boolean;
  accessRestrictionActive: boolean;
  policyViolationResolved: boolean;
}

export function verifySecurityResponse(input: VerificationInput): 'VERIFIED' | 'FAILED' | 'UNKNOWN' {
  if (!input.threatSignalDisappeared || !input.credentialInvalid || !input.artifactQuarantined || !input.accessRestrictionActive) return 'FAILED';
  return 'VERIFIED';
}
