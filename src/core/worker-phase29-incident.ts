import { randomUUID } from 'crypto';

export interface DataIncident {
  incidentId: string;
  resourceId: string;
  type: string;
  severity: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createDataIncident(input: Omit<DataIncident, 'incidentId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): DataIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.resourceId}:${input.type}`;
  return { incidentId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
