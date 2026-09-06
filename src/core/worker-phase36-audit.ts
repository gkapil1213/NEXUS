import { randomUUID } from 'crypto';
export function processAudit(input: any): any {
  return { id: randomUUID(), eventType: input.eventType, resourceType: input.resourceType, resourceId: input.resourceId, previousState: input.previousState, newState: input.newState, timestamp: new Date().toISOString() };
}
