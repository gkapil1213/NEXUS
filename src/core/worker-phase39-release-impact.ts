import { randomUUID } from 'crypto';
export function processReleaseImpact(input: any): any {
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    affectedServices: input.affectedServices || [],
    affectedEnvironments: input.affectedEnvironments || [],
    dependentSystems: input.dependentSystems || [],
    downstreamConsumers: input.downstreamConsumers || [],
    dataImpact: input.dataImpact || null,
    infrastructureImpact: input.infrastructureImpact || null,
    userImpact: input.userImpact || null,
    operationalImpact: input.operationalImpact || null,
  };
}
