export type DriftSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DriftInput {
  desiredFingerprint: string;
  actualFingerprint: string;
  driftDetected: boolean;
  affectedResource: string;
  severity: DriftSeverity;
  source: string;
  remediated: boolean;
}

export function evaluateDrift(input: DriftInput): DriftSeverity {
  if (!input.driftDetected) return 'NONE';
  return input.severity;
}
