import { randomUUID } from 'crypto';
export function processReleaseAudit(input: any): any {
  return { id: randomUUID(), releaseId: input.releaseId, eventType: input.eventType, action: input.action, previousState: input.previousState, newState: input.newState, timestamp: new Date().toISOString() };
}
