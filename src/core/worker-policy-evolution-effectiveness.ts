export type EvolutionEffectiveness =
  | 'EFFECTIVE'
  | 'PARTIALLY_EFFECTIVE'
  | 'DEGRADED'
  | 'INEFFECTIVE'
  | 'CONFLICTED'
  | 'INSUFFICIENT_DATA'
  | 'UNKNOWN';

export interface EvolutionEffectivenessInput {
  sampleSize: number;
  successRate: number;
  failureRate: number;
  rollbackRate: number;
  reliability?: number;
  availability?: number;
  latencyP95?: number;
  cost?: number;
  incidentCount?: number;
  recoveryTime?: number;
  conflictingMetrics?: boolean;
  telemetryFresh: boolean;
}

export function evaluateEvolutionEffectiveness(input: EvolutionEffectivenessInput): EvolutionEffectiveness {
  if (!input.telemetryFresh) {
    return 'UNKNOWN';
  }
  if (input.sampleSize < 10) {
    return 'INSUFFICIENT_DATA';
  }
  if (input.conflictingMetrics) {
    return 'CONFLICTED';
  }

  // Critical failures -> ineffective
  if (input.failureRate > 0.10 || input.rollbackRate > 0.05) {
    return 'INEFFECTIVE';
  }

  // Moderate failures -> degraded
  if (input.failureRate > 0.03 || input.rollbackRate > 0.02) {
    return 'DEGRADED';
  }

  // Check reliability, availability, latency thresholds if provided
  if (input.reliability !== undefined && input.reliability < 0.95) return 'DEGRADED';
  if (input.availability !== undefined && input.availability < 0.99) return 'DEGRADED';
  if (input.latencyP95 !== undefined && input.latencyP95 > 500) return 'DEGRADED'; // example threshold

  // If any incidents or long recovery -> partially effective
  if (input.incidentCount !== undefined && input.incidentCount > 0) return 'PARTIALLY_EFFECTIVE';
  if (input.recoveryTime !== undefined && input.recoveryTime > 10) return 'PARTIALLY_EFFECTIVE';

  // High success and good metrics -> effective
  if (input.successRate >= 0.99) {
    return 'EFFECTIVE';
  } else if (input.successRate >= 0.95) {
    return 'PARTIALLY_EFFECTIVE';
  }

  // Fallback
  return 'DEGRADED';
}
