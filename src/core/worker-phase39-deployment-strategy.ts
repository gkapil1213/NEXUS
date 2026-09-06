import { randomUUID } from 'crypto';
export function processDeploymentStrategy(input: any): any {
  const strategies = ['rolling','canary','blue-green','recreate'];
  if (input.strategy && !strategies.includes(input.strategy)) {
    throw new Error('Unknown strategy');
  }
  const strategy = input.strategy || 'rolling';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    strategy,
    reasons: input.reasons || [],
  };
}
