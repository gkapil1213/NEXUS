export type RollbackStatus = 'ROLLBACK_REQUESTED' | 'ROLLBACK_VALIDATING' | 'ROLLBACK_EXECUTING' | 'ROLLBACK_VERIFYING' | 'ROLLED_BACK' | 'ROLLBACK_FAILED';

export interface RollbackExecution {
  rollbackId: string;
  deploymentId: string;
  targetReleaseId: string;
  status: RollbackStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export function createRollbackExecution(deploymentId: string, targetReleaseId: string): RollbackExecution {
  const now = new Date().toISOString();
  return { rollbackId: `rb-${deploymentId}-${Date.now()}`, deploymentId, targetReleaseId, status: 'ROLLBACK_REQUESTED', createdAt: now, updatedAt: now, idempotencyKey: `${deploymentId}:${targetReleaseId}` };
}

export function transitionRollbackExecution(exec: RollbackExecution, next: RollbackStatus): RollbackExecution {
  const order: RollbackStatus[] = ['ROLLBACK_REQUESTED', 'ROLLBACK_VALIDATING', 'ROLLBACK_EXECUTING', 'ROLLBACK_VERIFYING', 'ROLLED_BACK'];
  if (exec.status === 'ROLLBACK_FAILED') throw new Error('rollback already failed');
  if (next === 'ROLLBACK_FAILED') return { ...exec, status: 'ROLLBACK_FAILED', updatedAt: new Date().toISOString() };
  const idx = order.indexOf(exec.status);
  const nextIdx = order.indexOf(next);
  if (nextIdx <= idx) throw new Error(`Invalid rollback transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
