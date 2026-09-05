export interface GovernanceException {
  exceptionId: string;
  policyId: string;
  resourceId: string;
  reason: string;
  requesterId: string;
  approverId: string;
  startTime: string;
  expirationTime: string;
  status: 'REQUESTED' | 'APPROVED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'DENIED';
}

export function createGovernanceException(input: Omit<GovernanceException, 'exceptionId'> & { exceptionId?: string }): GovernanceException {
  return { exceptionId: input.exceptionId ?? `ex-${Date.now()}`, ...input };
}

export function isExceptionActive(ex: GovernanceException): boolean {
  return ex.status === 'ACTIVE' && new Date(ex.expirationTime) > new Date();
}
