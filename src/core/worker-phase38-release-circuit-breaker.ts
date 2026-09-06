import { randomUUID } from 'crypto';
export function processReleaseCircuitBreaker(input: any): any {
  const failures = input.failures || 0;
  const threshold = input.threshold || 3;
  const state = input.state || (failures >= threshold ? 'OPEN' : 'CLOSED');
  return {
    id: randomUUID(),
    scope: input.scope || 'release',
    consecutiveFailures: failures,
    failureThreshold: threshold,
    state,
    openedAt: state === 'OPEN' ? new Date().toISOString() : null,
    cooldownUntil: null,
    updatedAt: new Date().toISOString(),
  };
}
