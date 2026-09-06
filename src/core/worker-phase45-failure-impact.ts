import { randomUUID } from 'crypto';
export function processFailureImpact(input: any): any {
  return {
    id: randomUUID(),
    serviceId: input.serviceId,
    failureType: input.failureType || 'unknown',
    affectedServices: input.affectedServices || [],
    blastRadius: input.blastRadius || 'unknown',
  };
}
