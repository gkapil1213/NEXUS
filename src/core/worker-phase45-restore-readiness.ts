import { randomUUID } from 'crypto';
export function processRestoreReadiness(input: any): any {
  let readiness = 'unknown';
  const reasons: string[] = [];
  if (input.backupAvailable && input.integrityValid && input.providerAvailable) readiness = 'READY';
  else if (input.backupAvailable === false || input.integrityValid === false) readiness = 'NOT_READY';
  else if (input.blocked) readiness = 'BLOCKED';
  return { id: randomUUID(), serviceId: input.serviceId, readinessState: readiness, reasons };
}


