export interface RollbackSafetyInput {
  targetArtifactExists: boolean;
  targetArtifactCorrupted: boolean;
  targetArtifactRevoked: boolean;
  targetVersionCompatible: boolean;
  governanceAllowed: boolean;
  securityPolicyAllowed: boolean;
  recoverySafetyAllowed: boolean;
  dependencyConstraintsMet: boolean;
}

export function evaluateRollbackSafety(input: RollbackSafetyInput): { allowed: boolean; reason: string } {
  if (!input.targetArtifactExists) return { allowed: false, reason: 'artifact missing' };
  if (input.targetArtifactCorrupted || input.targetArtifactRevoked) return { allowed: false, reason: 'artifact corrupted or revoked' };
  if (!input.targetVersionCompatible) return { allowed: false, reason: 'incompatible version' };
  if (!input.governanceAllowed || !input.securityPolicyAllowed || !input.recoverySafetyAllowed || !input.dependencyConstraintsMet) return { allowed: false, reason: 'policy denies rollback' };
  return { allowed: true, reason: 'OK' };
}
