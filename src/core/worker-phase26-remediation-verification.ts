export interface VerificationInput {
  health: string;
  errorRate: number;
  latency: number;
  availability: number;
  sloState: string;
  incidentState: string;
}

export function verifyRemediation(input: VerificationInput): 'VERIFIED' | 'NOT_VERIFIED' | 'FAILED' | 'UNKNOWN' {
  if (input.incidentState === 'RESOLVED' && input.health === 'HEALTHY' && input.sloState === 'SLO_MET') return 'VERIFIED';
  if (input.health === 'UNHEALTHY' || input.sloState === 'SLO_BREACHED') return 'FAILED';
  if (input.health === 'UNKNOWN') return 'UNKNOWN';
  return 'NOT_VERIFIED';
}
