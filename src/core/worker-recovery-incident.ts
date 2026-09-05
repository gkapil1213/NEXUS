export type RecoveryIncidentStatus = 'OPEN' | 'INVESTIGATING' | 'RECOVERING' | 'RESOLVED';

export interface RecoveryIncident {
  incidentId: string;
  type: string;
  affectedServices: string[];
  severity: string;
  status: RecoveryIncidentStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export function createRecoveryIncident(input: Omit<RecoveryIncident, 'incidentId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }): RecoveryIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.type}:${input.affectedServices.join(',')}`;
  const now = new Date().toISOString();
  return { incidentId: `inc-${Date.now()}`, ...input, status: 'OPEN', createdAt: now, updatedAt: now, idempotencyKey };
}
