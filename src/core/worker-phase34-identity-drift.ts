export type DriftSeverity = 'NO_DRIFT' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export function detectIdentityDrift(expectedFingerprint: string, observedFingerprint: string): DriftSeverity {
  if (expectedFingerprint === observedFingerprint) return 'NO_DRIFT';
  if (!expectedFingerprint || !observedFingerprint) return 'UNKNOWN';
  return 'LOW';
}
