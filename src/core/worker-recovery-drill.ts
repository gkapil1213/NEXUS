export type DrillStatus = 'PLANNED' | 'AUTHORIZED' | 'RUNNING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'ABORTED';

export interface RecoveryDrill {
  drillId: string;
  planId: string;
  status: DrillStatus;
  isDrill: boolean;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export function createRecoveryDrill(input: { planId: string; idempotencyKey?: string }): RecoveryDrill {
  const now = new Date().toISOString();
  return { drillId: `drill-${Date.now()}`, planId: input.planId, status: 'PLANNED', isDrill: true, createdAt: now, updatedAt: now, idempotencyKey: input.idempotencyKey ?? input.planId };
}
