import { randomUUID } from 'crypto';
export function processReleaseSafety(input: any): any {
  let safe = true;
  if (input.protectedResource || input.unknownProvider || input.unknownHealth) safe = false;
  return { id: randomUUID(), releaseId: input.releaseId, safe };
}
