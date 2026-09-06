import { randomUUID } from 'crypto';
export function processHealthGate(input: any): any {
  let decision = 'UNKNOWN';
  if (input.health === 'HEALTHY') decision = 'ALLOW';
  else if (input.health === 'DEGRADED') decision = 'PAUSE';
  else if (input.health === 'UNHEALTHY') decision = 'HALT';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    executionId: input.executionId || null,
    decision,
    observedAt: new Date().toISOString(),
  };
}
