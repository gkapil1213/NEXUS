export interface GovernanceRemediationRollbackRecord {
  rollbackId: string;
  executionId: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createGovernanceRemediationRollback(executionId: string): GovernanceRemediationRollbackRecord {
  return { rollbackId: `gov-rb-${executionId}-${Date.now()}`, executionId, status: 'REQUESTED', createdAt: new Date().toISOString(), idempotencyKey: executionId };
}
