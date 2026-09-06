import { randomUUID } from 'crypto';
export function processSafety(input: any): any {
  let safe = true;
  if (input.protected || input.unknownProvider || input.unknownCapability || input.unknownHealth) safe = false;
  return { id: randomUUID(), safe };
}
