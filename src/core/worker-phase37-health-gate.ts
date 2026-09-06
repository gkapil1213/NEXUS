import { randomUUID } from 'crypto';
export function processHealthGate(input: any): any {
  let decision = 'UNKNOWN';
  if (input.healthStatus === 'HEALTHY') decision = 'ALLOW';
  else if (input.healthStatus === 'DEGRADED') decision = 'PAUSE';
  else if (input.healthStatus === 'UNHEALTHY') decision = 'HALT';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    executionId: input.executionId,
    decision,
  };
}
