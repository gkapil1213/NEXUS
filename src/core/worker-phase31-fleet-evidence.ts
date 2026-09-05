import { randomUUID } from 'crypto';

export interface FleetEvidence {
  evidenceId: string;
  fleetId: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createFleetEvidence(input: Omit<FleetEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }): FleetEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.fleetId}:${input.type}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
