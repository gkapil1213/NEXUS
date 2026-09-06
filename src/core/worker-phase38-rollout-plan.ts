import { randomUUID } from 'crypto';
export function processRolloutPlan(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const strategy = input.strategy ? input.strategy.toUpperCase() : 'CANARY';
  const defaultWaves = strategy === 'CANARY' ? [
    { sequence: 1, percentage: 1 },
    { sequence: 2, percentage: 5 },
    { sequence: 3, percentage: 25 },
    { sequence: 4, percentage: 50 },
    { sequence: 5, percentage: 100 }
  ] : strategy === 'PROGRESSIVE' ? [
    { sequence: 1, percentage: 10 },
    { sequence: 2, percentage: 50 },
    { sequence: 3, percentage: 100 }
  ] : [
    { sequence: 1, percentage: 100 }
  ];
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    strategy,
    targetEnvironment: input.targetEnvironment || null,
    waves: input.waves || defaultWaves,
    createdAt: new Date().toISOString(),
  };
}
