import { randomUUID } from 'crypto';
export function processLineage(input: any): any {
  return { id: randomUUID(), incidentId: input.incidentId, sourceSignalId: input.sourceSignalId || null, executionId: input.executionId || null, rollbackId: input.rollbackId || null, escalationId: input.escalationId || null };
}
