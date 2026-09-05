export interface VerificationInput {
  serviceHealth: string;
  sloStatus: string;
  telemetryRecovery: boolean;
  errorRate: number;
  latency: number;
  dependencyHealth: string;
  runtimeStability: boolean;
}

export function verifyRemediation(input: VerificationInput): 'VERIFIED' | 'FAILED' | 'UNKNOWN' {
  if (input.serviceHealth !== 'HEALTHY' || input.sloStatus === 'VIOLATED') return 'FAILED';
  if (!input.telemetryRecovery || !input.runtimeStability) return 'FAILED';
  return 'VERIFIED';
}
