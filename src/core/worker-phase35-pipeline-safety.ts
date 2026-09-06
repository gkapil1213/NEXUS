import { randomUUID } from 'crypto';

export function processPipelineSafety(input: any): any {
  let safe = true;
  if (input.protected || input.providerUnknown || input.healthUnknown) safe = false;
  return { id: randomUUID(), safe };
}
