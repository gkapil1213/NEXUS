import { randomUUID } from 'crypto';
export function processRecoveryVerification(input: any): any {
  let state = 'unknown';
  if (input.verified) state = 'verified';
  else if (input.failed) state = 'failed';
  else if (input.partial) state = 'partial';
  return { id: randomUUID(), executionId: input.executionId, verificationType: input.verificationType || 'generic', verificationState: state, evidenceRef: input.evidenceRef || null };
}
