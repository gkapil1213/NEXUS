import { randomUUID } from 'crypto';

export type IncidentStatus = 'DETECTED' | 'TRIAGED' | 'INVESTIGATING' | 'MITIGATING' | 'RECOVERING' | 'VERIFIED' | 'RESOLVED' | 'ESCALATED' | 'BLOCKED' | 'UNKNOWN' | 'REOPENED';

export interface ProductionIncident {
  incidentId: string;
  environmentId: string;
  releaseId?: string;
  service: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: IncidentStatus;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  DETECTED: ['TRIAGED', 'ESCALATED'],
  TRIAGED: ['INVESTIGATING', 'BLOCKED', 'UNKNOWN'],
  INVESTIGATING: ['MITIGATING', 'ESCALATED'],
  MITIGATING: ['RECOVERING', 'ESCALATED'],
  RECOVERING: ['VERIFIED', 'BLOCKED'],
  VERIFIED: ['RESOLVED'],
  RESOLVED: ['REOPENED'],
  ESCALATED: ['INVESTIGATING', 'RESOLVED'],
  BLOCKED: ['ESCALATED', 'RESOLVED'],
  UNKNOWN: ['TRIAGED', 'ESCALATED'],
  REOPENED: ['TRIAGED'],
};

export function createProductionIncident(
  input: Omit<ProductionIncident, 'incidentId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): ProductionIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.environmentId}:${input.service}:${input.correlationId}`;
  const now = new Date().toISOString();
  return { incidentId: randomUUID(), ...input, status: 'DETECTED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionIncident(incident: ProductionIncident, next: IncidentStatus): ProductionIncident {
  if (!VALID_TRANSITIONS[incident.status].includes(next)) {
    throw new Error(`Illegal incident transition from ${incident.status} to ${next}`);
  }
  return { ...incident, status: next, updatedAt: new Date().toISOString() };
}
