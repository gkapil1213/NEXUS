export interface InfrastructureVerificationInput { health: string; capacityState: string; costState: string; rollbackState: string; }
export function verifyInfrastructureChange(input: InfrastructureVerificationInput): 'VERIFIED' | 'FAILED' | 'UNKNOWN' {
  if (input.health === 'UNHEALTHY' || input.capacityState === 'UNDER_CAPACITY') return 'FAILED';
  if (input.health === 'HEALTHY' && input.capacityState === 'HEALTHY_CAPACITY') return 'VERIFIED';
  return 'UNKNOWN';
}
