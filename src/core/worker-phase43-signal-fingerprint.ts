import { createHash } from 'crypto';
export function processSignalFingerprint(input: any): any {
  const parts = [input.sourceId, input.signalType, input.serviceId, input.resourceId, input.timestamp, input.value].filter(Boolean).join('|');
  const fingerprint = createHash('sha256').update(parts).digest('hex');
  return { fingerprint, ...input };
}
