import { randomUUID } from 'crypto';
export function processReleaseBlastRadius(input: any): any {
  let classification = 'LOW';
  const score = (input.resourceCount || 0) + (input.criticalResources || 0)*10 + (input.customerFacing || 0)*5;
  if (score > 200) classification = 'CRITICAL';
  else if (score >= 100) classification = 'HIGH';
  else if (score > 20) classification = 'MEDIUM';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    resourceCount: input.resourceCount || 0,
    environmentCount: input.environmentCount || 0,
    serviceCount: input.serviceCount || 0,
    dependencyDepth: input.dependencyDepth || 0,
    criticalResources: input.criticalResources || 0,
    customerFacing: input.customerFacing || 0,
    classification,
  };
}
