export interface PolicyException {
  exceptionId: string;
  policyId: string;
  scope: string;
  reason: string;
  requesterId: string;
  approverId: string;
  startAt: string;
  expiresAt: string;
  riskAcceptance: string;
  compensatingControl: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

export function createPolicyException(input: Omit<PolicyException, 'exceptionId'> & { exceptionId?: string }): PolicyException {
  return {
    exceptionId: input.exceptionId ?? `exception-${Date.now()}`,
    ...input,
  };
}

export function isExceptionValid(ex: PolicyException): boolean {
  return ex.status === 'ACTIVE' && new Date(ex.expiresAt) > new Date();
}
