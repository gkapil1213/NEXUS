import { randomUUID } from 'crypto';
export function processBackupObservation(input: any): any {
  return {
    id: randomUUID(),
    backupId: input.backupId,
    observedAt: input.observedAt || new Date().toISOString(),
    status: input.status || 'unknown',
    sizeBytes: input.sizeBytes || null,
    integrityResult: input.integrityResult || 'unknown',
    freshnessSeconds: input.freshnessSeconds || null,
  };
}
