import { randomUUID } from 'crypto';

export interface GovernanceIncident {
  incidentId: string;
  violationId: string;
  policyId: string;
  resourceId: string;
  risk: string;
  severity: string;
  blastRadius: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createGovernanceIncident(input: Omit<GovernanceIncident, 'incidentId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): GovernanceIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.violationId}:${input.resourceId}`;
  return { incidentId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
