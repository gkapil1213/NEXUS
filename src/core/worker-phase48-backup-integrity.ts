import { randomUUID } from 'crypto';
export function processBackupIntegrity(input: any): any {
  let state = 'unknown';
  if (input.verified) state = 'verified';
  else if (input.failed) state = 'failed';
  else if (input.pending) state = 'pending';
  return { id: randomUUID(), backupId: input.backupId, integrityState: state };
}
