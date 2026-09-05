import { randomUUID } from 'crypto';

export type SecurityIncidentStatus = 'DETECTED' | 'TRIAGED' | 'CONTAINMENT_PENDING' | 'CONTAINED' | 'REMEDIATION_PENDING' | 'REMEDIATING' | 'VERIFYING' | 'RESOLVED' | 'ROLLED_BACK' | 'ESCALATED' | 'CLOSED';

export interface SecurityIncident {
  incidentId: string;
  title: string;
  severity: string;
  status: SecurityIncidentStatus;
  signalIds: string[];
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<SecurityIncidentStatus, SecurityIncidentStatus[]> = {
  DETECTED: ['TRIAGED', 'ESCALATED', 'CLOSED'],
  TRIAGED: ['CONTAINMENT_PENDING', 'ESCALATED', 'CLOSED'],
  CONTAINMENT_PENDING: ['CONTAINED', 'ESCALATED'],
  CONTAINED: ['REMEDIATION_PENDING', 'ESCALATED'],
  REMEDIATION_PENDING: ['REMEDIATING', 'ESCALATED'],
  REMEDIATING: ['VERIFYING', 'ESCALATED'],
  VERIFYING: ['RESOLVED', 'ROLLED_BACK', 'ESCALATED'],
  RESOLVED: ['CLOSED'],
  ROLLED_BACK: ['ESCALATED', 'CLOSED'],
  ESCALATED: ['CLOSED'],
  CLOSED: [],
};

export function createSecurityIncident(input: Omit<SecurityIncident, 'incidentId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): SecurityIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.title}:${input.signalIds.join(',')}`;
  const now = new Date().toISOString();
  return { incidentId: randomUUID(), ...input, status: 'DETECTED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionSecurityIncident(incident: SecurityIncident, next: SecurityIncidentStatus): SecurityIncident {
  if (!VALID_TRANSITIONS[incident.status].includes(next)) throw new Error(`Illegal security incident transition ${incident.status}->${next}`);
  return { ...incident, status: next, updatedAt: new Date().toISOString() };
}
