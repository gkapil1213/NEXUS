import { randomUUID } from 'crypto';
export function processPromotion(input: any): any {
  let decision = 'PROMOTE';
  if (input.healthGateDecision && input.healthGateDecision !== 'ALLOW') decision = 'HOLD';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    executionId: input.executionId,
    decision,
  };
}
