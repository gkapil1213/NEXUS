import { randomUUID } from 'crypto';
export function processRecoveryVerification(input: any): any {
  let state = 'unknown';
  if (input.recovered) state = 'recovered';
  else if (input.partial) state = 'partial';
  else if (input.failed) state = 'failed';
  else if (input.regression) state = 'regression';
  return { id: randomUUID(), executionId: input.executionId, state, evidenceRef: input.evidenceRef || null };
}
