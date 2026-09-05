export interface RollbackRecord {
  rollbackId: string;
  remediationId: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRemediationRollback(remediationId: string): RollbackRecord {
  return { rollbackId: `rb-${remediationId}-${Date.now()}`, remediationId, status: 'REQUESTED', createdAt: new Date().toISOString(), idempotencyKey: remediationId };
}
