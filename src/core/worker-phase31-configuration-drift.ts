export type DriftSeverity = 'NO_DRIFT' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export function detectConfigDrift(desiredFingerprint: string, observedFingerprint: string): DriftSeverity {
  if (desiredFingerprint === observedFingerprint) return 'NO_DRIFT';
  if (!desiredFingerprint || !observedFingerprint) return 'UNKNOWN';
  return 'LOW'; // simplified; real implementation would compare diffs
}
