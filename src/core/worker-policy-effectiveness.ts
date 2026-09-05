export type Effectiveness = 'EFFECTIVE' | 'DEGRADED' | 'INEFFECTIVE' | 'INSUFFICIENT_DATA';

export interface EffectivenessInput {
  sampleSize: number;
  successRate: number;
  failureRate: number;
  rollbackRate: number;
  reliability?: number;
  costImpact?: number;
  incidentCount?: number;
  verificationPassRate?: number;
}

export function evaluateEffectiveness(input: EffectivenessInput): Effectiveness {
  if (input.sampleSize < 10) {
    return 'INSUFFICIENT_DATA';
  }

  // If there are any critical failures or many rollbacks, the policy is ineffective.
  if (input.failureRate > 0.10 || input.rollbackRate > 0.05) {
    return 'INEFFECTIVE';
  }

  // If success is marginal, degrade it.
  if (input.successRate < 0.95) {
    return 'DEGRADED';
  }

  // Optional reliability check – if provided and below threshold, degrade.
  if (input.reliability !== undefined && input.reliability < 0.99) {
    return 'DEGRADED';
  }

  // If incident count is provided and greater than zero, degrade.
  if (input.incidentCount !== undefined && input.incidentCount > 0) {
    return 'DEGRADED';
  }

  // Otherwise, the policy appears effective.
  return 'EFFECTIVE';
}