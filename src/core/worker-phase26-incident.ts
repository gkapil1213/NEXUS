import { randomUUID } from 'crypto';

export type IncidentStatus = 'NEW' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'MITIGATING' | 'MONITORING' | 'RESOLVED' | 'CLOSED';

export interface Incident {
  incidentId: string;
  service: string;
  environment: string;
  severity: 'P1' | 'P2' | 'P3' | 'P4';
  status: IncidentStatus;
  title: string;
  description: string;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  NEW: ['ACKNOWLEDGED', 'CLOSED'],
  ACKNOWLEDGED: ['INVESTIGATING', 'CLOSED'],
  INVESTIGATING: ['MITIGATING', 'CLOSED'],
  MITIGATING: ['MONITORING', 'CLOSED'],
  MONITORING: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

export function createIncident(
  input: Omit<Incident, 'incidentId' | 'createdAt' | 'updatedAt' | 'status' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): Incident {
  const fingerprint = `${input.service}:${input.environment}:${input.title}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return { incidentId: randomUUID(), ...input, status: 'NEW', fingerprint, createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionIncident(incident: Incident, next: IncidentStatus): Incident {
  if (!VALID_TRANSITIONS[incident.status].includes(next)) throw new Error(`Illegal incident transition ${incident.status}->${next}`);
  return { ...incident, status: next, updatedAt: new Date().toISOString() };
}
