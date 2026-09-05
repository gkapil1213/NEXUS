export interface RemediationRollbackRecord {
  rollbackId: string;
  executionId: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRemediationRollback(executionId: string): RemediationRollbackRecord {
  return { rollbackId: `rr-${executionId}-${Date.now()}`, executionId, status: 'REQUESTED', createdAt: new Date().toISOString(), idempotencyKey: executionId };
}
