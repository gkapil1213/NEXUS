import { randomUUID } from 'crypto';
export function processResourceDependency(input: any): any {
  return { id: randomUUID(), resourceId: input.resourceId, upstream: input.upstream || [], downstream: input.downstream || [], sharedInfrastructure: input.sharedInfrastructure || [], criticalWorkloads: input.criticalWorkloads || [], blastRadius: input.blastRadius || 'unknown' };
}
