import { randomUUID } from 'crypto';

export interface FleetRolloutPlan {
  planId: string;
  fleetId: string;
  targetEnvironments: string[];
  desiredVersion: string;
  desiredConfig: string;
  waves: string[];
  healthGates: string[];
  safetyGates: string[];
  governanceRequirements: string[];
  rollbackStrategy: string;
  blastRadius: string;
  dependencies: string[];
  risk: string;
  evidenceRequirements: string[];
  idempotencyKey: string;
  createdAt: string;
}

export function createFleetRolloutPlan(
  input: Omit<FleetRolloutPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): FleetRolloutPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.fleetId}:${input.desiredVersion}:${input.desiredConfig}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
