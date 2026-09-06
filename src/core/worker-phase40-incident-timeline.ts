import { randomUUID } from 'crypto';
export function processIncidentTimeline(input: any): any {
  return {
    id: randomUUID(),
    incidentId: input.incidentId,
    eventType: input.eventType,
    actor: input.actor || 'system',
    previousState: input.previousState || null,
    newState: input.newState || null,
    evidenceRef: input.evidenceRef || null,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}
