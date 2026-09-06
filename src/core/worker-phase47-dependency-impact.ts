import { randomUUID } from 'crypto';
export function processDependencyImpact(input: any): any {
  return { id: randomUUID(), resourceId: input.resourceId, dependentServices: input.dependentServices || [], blastRadius: input.blastRadius || 'unknown' };
}
