import { randomUUID } from 'crypto';
export function processAudit(input: any): any {
  return { id: randomUUID(), incidentId: input.incidentId, eventType: input.eventType, actor: input.actor || 'system', action: input.action || input.eventType, previousState: input.previousState || null, newState: input.newState || null, reason: input.reason || null, timestamp: new Date().toISOString() };
}
