import { randomUUID } from 'crypto';

export interface FleetRemediationPlan {
  planId: string;
  fleetId: string;
  actions: string[];
  risk: string;
  blastRadius: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createFleetRemediationPlan(input: Omit<FleetRemediationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): FleetRemediationPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.fleetId}:${input.actions.join(',')}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
