import { randomUUID } from 'crypto';
export function processIncidentBlastRadius(input: any): any {
  let classification = 'unknown';
  const score = (input.resourceCount || 0) + (input.criticalResources || 0)*10 + (input.customerFacing || 0)*5;
  if (score > 200) classification = 'critical';
  else if (score >= 100) classification = 'high';
  else if (score >= 50) classification = 'medium';
  else classification = 'low';
  return {
    id: randomUUID(),
    incidentId: input.incidentId,
    resourceCount: input.resourceCount || 0,
    serviceCount: input.serviceCount || 0,
    environmentCount: input.environmentCount || 0,
    dependencyDepth: input.dependencyDepth || 0,
    criticalResources: input.criticalResources || 0,
    customerFacing: input.customerFacing || 0,
    classification,
  };
}
