import { randomUUID } from 'crypto';

export interface FleetIncident {
  incidentId: string;
  fleetId: string;
  type: string;
  severity: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createFleetIncident(input: Omit<FleetIncident, 'incidentId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): FleetIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.fleetId}:${input.type}`;
  return { incidentId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
