import { randomUUID } from 'crypto';
export function processDependencyImpact(input: any): any {
  let blast = 'low';
  if (input.critical) blast = 'critical';
  else if (input.high) blast = 'high';
  else if (input.medium) blast = 'medium';
  return { id: randomUUID(), serviceId: input.serviceId, affectedDependencies: input.affectedDependencies || [], blastRadius: blast };
}
