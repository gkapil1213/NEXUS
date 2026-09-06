import { randomUUID } from 'crypto';
export function processIncident(input: any): any {
  const id = input.signature || randomUUID();
  return { id, resourceId: input.resourceId, severity: input.severity || 'medium', signature: input.signature || null, state: 'open' };
}
