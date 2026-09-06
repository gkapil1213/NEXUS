import { randomUUID } from 'crypto';
export function processVerification(input: any): any {
  let state = 'unknown';
  if (input.improved) state = 'improved';
  else if (input.unchanged) state = 'unchanged';
  else if (input.degraded) state = 'degraded';
  return { id: randomUUID(), executionId: input.executionId, state, evidenceRef: input.evidenceRef || null };
}
