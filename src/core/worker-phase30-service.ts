import { randomUUID } from 'crypto';

export interface Service {
  serviceId: string;
  name: string;
  environment: string;
  version: string;
  owner: string;
  criticality: string;
  protected: boolean;
  healthState: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createService(input: Omit<Service, 'serviceId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): Service {
  const idempotencyKey = input.idempotencyKey ?? `${input.name}:${input.environment}:${input.version}`;
  return { serviceId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
