export interface FleetRollbackRecord {
  rollbackId: string;
  executionId: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createFleetRollback(executionId: string): FleetRollbackRecord {
  return { rollbackId: `fleet-rb-${executionId}-${Date.now()}`, executionId, status: 'REQUESTED', createdAt: new Date().toISOString(), idempotencyKey: executionId };
}
