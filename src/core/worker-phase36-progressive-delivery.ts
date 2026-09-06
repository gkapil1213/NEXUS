import { randomUUID } from 'crypto';
export function processProgressiveDelivery(input: any): any {
  const strategies = ['CANARY','LINEAR','STEPWISE','BLUE_GREEN','ROLLING'];
  const strategy = input.strategy && strategies.includes(input.strategy.toUpperCase()) ? input.strategy.toUpperCase() : 'CANARY';
  return { id: input.idempotencyKey || randomUUID(), releaseId: input.releaseId, strategy, provider: input.provider };
}
