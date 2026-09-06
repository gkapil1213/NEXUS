import { randomUUID } from 'crypto';
export function processRecoveryReadiness(input: any): any {
  let readiness = 'unknown';
  let confidence = input.confidence || 0;
  if (input.backupFresh && input.integrityVerified && input.providerReady) readiness = 'ready';
  else if (input.blocked) readiness = 'blocked';
  else if (input.missingInfo) readiness = 'not_ready';
  return { id: randomUUID(), assetId: input.assetId, readinessState: readiness, confidence };
}
