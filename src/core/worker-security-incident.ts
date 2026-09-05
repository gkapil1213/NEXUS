import { randomUUID } from 'crypto';

export type SecurityIncidentStatus = 'OPEN' | 'INVESTIGATING' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';

export interface SecurityIncident {
  incidentId: string;
  findingIds: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  status: SecurityIncidentStatus;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createSecurityIncident(
  input: Omit<SecurityIncident, 'incidentId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): SecurityIncident {
  const idempotencyKey = input.idempotencyKey ?? input.findingIds.join(',');
  const now = new Date().toISOString();
  return { incidentId: randomUUID(), ...input, createdAt: now, updatedAt: now, idempotencyKey };
}
