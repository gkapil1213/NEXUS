import { randomUUID } from 'crypto';
export function processIncidentImpact(input: any): any {
  return {
    id: randomUUID(),
    incidentId: input.incidentId,
    affectedServices: input.affectedServices || [],
    affectedEnvironments: input.affectedEnvironments || [],
    affectedResources: input.affectedResources || [],
    customerImpact: input.customerImpact || null,
    businessImpact: input.businessImpact || null,
    technicalImpact: input.technicalImpact || null,
    reliabilityImpact: input.reliabilityImpact || null,
  };
}
