import { randomUUID } from 'crypto';
export function processBackupFreshness(input: any): any {
  let state = 'unknown';
  if (input.freshnessSeconds !== undefined && input.thresholdSeconds !== undefined) {
    if (input.freshnessSeconds <= input.thresholdSeconds) state = 'fresh';
    else state = 'stale';
  }
  if (input.missing) state = 'missing';
  return { id: randomUUID(), backupId: input.backupId, freshnessState: state };
}
