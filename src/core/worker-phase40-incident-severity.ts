import { randomUUID } from 'crypto';
export function processIncidentSeverity(input: any): any {
  let severity = 'unknown';
  if (input.critical) severity = 'critical';
  else if (input.high) severity = 'high';
  else if (input.medium) severity = 'medium';
  else if (input.low) severity = 'low';
  else if (input.informational) severity = 'informational';
  return { id: randomUUID(), incidentId: input.incidentId, severity, reasons: input.reasons || [] };
}
