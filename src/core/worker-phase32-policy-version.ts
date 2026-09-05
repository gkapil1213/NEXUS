export interface PolicyVersion {
  policyId: string;
  version: number;
  effectiveVersion: number;
  previousVersion: number;
  versionFingerprint: string;
  changeReason: string;
  createdBy: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createPolicyVersion(input: PolicyVersion): PolicyVersion {
  return { ...input, createdAt: new Date().toISOString(), idempotencyKey: `${input.policyId}:${input.version}` };
}
