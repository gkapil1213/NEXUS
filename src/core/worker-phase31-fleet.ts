import { randomUUID } from 'crypto';

export interface Fleet {
  fleetId: string;
  name: string;
  fleetType: string;
  environmentScope: string[];
  memberResources: string[];
  criticality: string;
  ownership: string;
  health: string;
  desiredState: string;
  observedState: string;
  version: string;
  configurationFingerprint: string;
  protectionState: string;
  operationalPolicy: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export function createFleet(
  input: Omit<Fleet, 'fleetId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): Fleet {
  const idempotencyKey = input.idempotencyKey ?? `${input.name}:${input.fleetType}:${input.environmentScope.join(',')}`;
  const now = new Date().toISOString();
  return { fleetId: randomUUID(), ...input, createdAt: now, updatedAt: now, idempotencyKey };
}
