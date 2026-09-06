import { randomUUID } from 'crypto';
export function processLineage(input: any): any {
  return { id: randomUUID(), serviceId: input.serviceId, findingId: input.findingId || null, riskId: input.riskId || null, incidentId: input.incidentId || null, executionId: input.executionId || null, rollbackId: input.rollbackId || null };
}
