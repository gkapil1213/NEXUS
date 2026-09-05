import { randomUUID } from 'crypto';

export interface InfrastructureIncident {
  incidentId: string;
  resourceId: string;
  changeId: string;
  severity: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createInfrastructureIncident(input: Omit<InfrastructureIncident, 'incidentId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): InfrastructureIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.resourceId}:${input.changeId}`;
  return { incidentId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
