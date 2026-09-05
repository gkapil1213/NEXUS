import { randomUUID } from 'crypto';

export interface RuntimeIncident {
  incidentId: string;
  serviceId: string;
  type: string;
  severity: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRuntimeIncident(input: Omit<RuntimeIncident, 'incidentId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): RuntimeIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.serviceId}:${input.type}`;
  return { incidentId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
