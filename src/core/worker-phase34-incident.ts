import { randomUUID } from 'crypto';

export interface Incident {
  incidentId: string;
  identityId: string;
  type: string;
  severity: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createIncident(input: Omit<Incident, 'incidentId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): Incident {
  const idempotencyKey = input.idempotencyKey ?? `${input.identityId}:${input.type}`;
  return { incidentId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
