import { randomUUID } from 'crypto';
export function processImpact(input: any): any {
  return { id: randomUUID(), serviceId: input.serviceId, affectedServices: input.affectedServices || [], affectedResources: input.affectedResources || [], impactEstimate: input.impactEstimate || null, blastRadius: input.blastRadius || 'unknown' };
}
