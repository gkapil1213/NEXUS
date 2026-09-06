import { randomUUID } from 'crypto';
export function processAudit(input: any): any {
  return { id: randomUUID(), eventType: input.eventType, actor: input.actor || 'system', action: input.action || input.eventType, resource: input.resource, decision: input.decision || null, previousState: input.previousState || null, newState: input.newState || null, reason: input.reason || null, evidenceRef: input.evidenceRef || null, timestamp: new Date().toISOString() };
}
