import { randomUUID } from 'crypto';
export function processRolloutWave(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    rolloutId: input.rolloutId,
    waveNumber: input.waveNumber || 1,
    targetScope: input.targetScope || null,
    percentage: input.percentage || 0,
    state: input.state || 'pending',
    startTime: input.startTime || null,
    completionTime: input.completionTime || null,
    healthResult: input.healthResult || null,
    riskResult: input.riskResult || null,
    decision: input.decision || null,
    executionRef: input.executionRef || null,
  };
}
