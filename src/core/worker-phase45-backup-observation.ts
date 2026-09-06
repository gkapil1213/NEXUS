import { randomUUID } from 'crypto';
export function processBackupObservation(input: any): any {
  return {
    id: randomUUID(),
    serviceId: input.serviceId,
    backupId: input.backupId || null,
    backupAgeSeconds: input.backupAgeSeconds,
    backupStatus: input.backupStatus || 'unknown',
    integrityState: input.integrityState || 'unknown',
    restorePointId: input.restorePointId || null,
  };
}
