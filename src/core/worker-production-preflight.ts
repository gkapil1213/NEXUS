export interface PreflightInput {
  environmentExists: boolean;
  environmentReachable: boolean;
  deploymentTargetAvailable: boolean;
  artifactExists: boolean;
  artifactIntegrityValid: boolean;
  releaseExists: boolean;
  releaseApproved: boolean;
  governanceAllows: boolean;
  safetyAllows: boolean;
  requiredCredentialsExist: boolean;
  requiredToolsExist: boolean;
  dependenciesAvailable: boolean;
  capacitySatisfied: boolean;
  deploymentPolicySatisfied: boolean;
  rollbackCapabilityExists: boolean;
}

export function runPreflight(input: PreflightInput): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.environmentExists) reasons.push('environment missing');
  if (!input.environmentReachable) reasons.push('environment unreachable');
  if (!input.deploymentTargetAvailable) reasons.push('deployment target unavailable');
  if (!input.artifactExists) reasons.push('artifact missing');
  if (!input.artifactIntegrityValid) reasons.push('artifact integrity invalid');
  if (!input.releaseExists) reasons.push('release missing');
  if (!input.releaseApproved) reasons.push('release not approved');
  if (!input.governanceAllows) reasons.push('governance blocked');
  if (!input.safetyAllows) reasons.push('safety blocked');
  if (!input.requiredCredentialsExist) reasons.push('credentials missing');
  if (!input.requiredToolsExist) reasons.push('required tools missing');
  if (!input.dependenciesAvailable) reasons.push('dependencies unavailable');
  if (!input.capacitySatisfied) reasons.push('capacity not satisfied');
  if (!input.deploymentPolicySatisfied) reasons.push('deployment policy violated');
  if (!input.rollbackCapabilityExists) reasons.push('rollback capability missing');
  return { passed: reasons.length === 0, reasons };
}
