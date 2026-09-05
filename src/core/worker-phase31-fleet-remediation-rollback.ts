export interface FleetRemediationRollbackRecord {
  rollbackId: string;
  executionId: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createFleetRemediationRollback(executionId: string): FleetRemediationRollbackRecord {
  return { rollbackId: `fleet-rem-rb-${executionId}-${Date.now()}`, executionId, status: 'REQUESTED', createdAt: new Date().toISOString(), idempotencyKey: executionId };
}
