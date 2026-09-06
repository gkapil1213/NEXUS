import { randomUUID } from 'crypto';
export function processOwnership(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    owner: input.owner || null,
    team: input.team || null,
    service: input.service || null,
    project: input.project || null,
    environment: input.environment || null,
    costCenter: input.costCenter || null,
    criticality: input.criticality || 'unknown',
  };
}
