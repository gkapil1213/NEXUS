export type VersionDriftSeverity = 'NO_DRIFT' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export function detectVersionDrift(desiredVersion: string, observedVersions: string[]): VersionDriftSeverity {
  if (observedVersions.length === 0) return 'UNKNOWN';
  const mismatches = observedVersions.filter(v => v !== desiredVersion).length;
  if (mismatches === 0) return 'NO_DRIFT';
  if (mismatches === observedVersions.length) return 'HIGH';
  return 'LOW';
}
