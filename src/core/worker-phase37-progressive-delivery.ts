import { randomUUID } from 'crypto';
export function processProgressiveDelivery(input: any): any {
  const strategies = ['CANARY','BLUE_GREEN','ROLLING'];
  const strategy = input.strategy && strategies.includes(input.strategy.toUpperCase()) ? input.strategy.toUpperCase() : 'CANARY';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    strategy,
    stages: input.stages || [],
  };
}
