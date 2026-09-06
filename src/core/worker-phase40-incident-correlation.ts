import { randomUUID } from 'crypto';
export function processIncidentCorrelation(input: any): any {
  const correlated = input.correlated !== undefined ? input.correlated : true;
  return {
    id: randomUUID(),
    incidentId: input.incidentId,
    signalId: input.signalId,
    correlated,
    correlationKey: input.correlationKey || null,
  };
}
