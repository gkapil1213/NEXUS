export interface RollbackRecord { rollbackId: string; executionId: string; status: string; createdAt: string; idempotencyKey: string; }
export function createInfrastructureRollback(executionId: string): RollbackRecord {
  return { rollbackId: `rb-${executionId}-${Date.now()}`, executionId, status: 'REQUESTED', createdAt: new Date().toISOString(), idempotencyKey: executionId };
}
