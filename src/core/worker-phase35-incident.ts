import { randomUUID } from 'crypto';

export function processIncident(input: any): any {
  const id = input.signature ? input.signature : randomUUID();
  return {
    id,
    pipelineId: input.pipelineId,
    severity: input.severity || 'MEDIUM',
    signature: input.signature || null,
    resolutionState: 'OPEN',
  };
}
