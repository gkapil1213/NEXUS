import { randomUUID } from 'crypto';
export function processIncident(input: any): any {
  const id = input.signature || randomUUID();
  return { id, serviceId: input.serviceId, severity: input.severity || 'medium', signature: input.signature || null, resolutionState: 'open' };
}
