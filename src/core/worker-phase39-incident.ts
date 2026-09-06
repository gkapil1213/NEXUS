import { randomUUID } from 'crypto';
export function processIncident(input: any): any {
  const id = input.signature || randomUUID();
  return { id, releaseId: input.releaseId, severity: input.severity || 'MEDIUM', signature: input.signature || null, state: 'open' };
}
