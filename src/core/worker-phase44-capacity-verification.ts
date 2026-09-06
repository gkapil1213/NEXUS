import { randomUUID } from 'crypto';
export function processCapacityVerification(input: any): any {
  let state = 'unknown';
  if (input.verificationSuccess) state = 'success';
  else if (input.regression) state = 'regression';
  else if (input.failed) state = 'failed';
  return { id: randomUUID(), executionId: input.executionId, state, evidenceRef: input.evidenceRef || null };
}
