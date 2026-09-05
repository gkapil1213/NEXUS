export type FailbackStatus = 'PLANNED' | 'APPROVED' | 'EXECUTING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';

export interface FailbackExecution {
  failbackId: string;
  failoverExecutionId: string;
  primaryHealth: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  status: FailbackStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export function createFailbackExecution(
  input: Omit<FailbackExecution, 'failbackId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): FailbackExecution {
  const idempotencyKey = input.idempotencyKey ?? input.failoverExecutionId;
  const now = new Date().toISOString();
  return { failbackId: `fb-${Date.now()}`, ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}
