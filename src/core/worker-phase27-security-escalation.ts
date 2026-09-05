export interface EscalationRecord {
  escalationId: string;
  incidentId: string;
  reason: string;
  timestamp: string;
}

export function createSecurityEscalation(incidentId: string, reason: string): EscalationRecord {
  return { escalationId: `esc-${incidentId}-${Date.now()}`, incidentId, reason, timestamp: new Date().toISOString() };
}
