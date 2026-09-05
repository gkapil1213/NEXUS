export type DriftState = 'NO_DRIFT' | 'LOW_DRIFT' | 'MODERATE_DRIFT' | 'HIGH_DRIFT' | 'CRITICAL_DRIFT' | 'INSUFFICIENT_DATA' | 'UNKNOWN';

export interface DriftMetrics {
  successRate: number;
  failureRate: number;
  latencyP95: number;
  cost: number;
  reliability: number;
}

export function detectDrift(
  baseline: DriftMetrics,
  recent: DriftMetrics,
  telemetryFresh: boolean,
): DriftState {
  if (!telemetryFresh) {
    return 'UNKNOWN';
  }

  // Validate essential metrics are present and non‑zero baseline for relative comparisons
  if (
    baseline.successRate === undefined ||
    recent.successRate === undefined ||
    baseline.latencyP95 <= 0 ||
    baseline.cost <= 0 ||
    baseline.reliability === undefined
  ) {
    return 'INSUFFICIENT_DATA';
  }

  const successDelta = Math.abs(recent.successRate - baseline.successRate);
  const failureDelta = Math.abs(recent.failureRate - baseline.failureRate);
  const latencyDelta = Math.abs(recent.latencyP95 - baseline.latencyP95) / baseline.latencyP95;
  const costDelta = Math.abs(recent.cost - baseline.cost) / baseline.cost;
  const reliabilityDelta = Math.abs(recent.reliability - baseline.reliability);

  const maxDelta = Math.max(successDelta, failureDelta, latencyDelta, costDelta, reliabilityDelta);

  if (maxDelta < 0.02) return 'NO_DRIFT';
  if (maxDelta < 0.05) return 'LOW_DRIFT';
  if (maxDelta < 0.15) return 'MODERATE_DRIFT';
  if (maxDelta < 0.30) return 'HIGH_DRIFT';
  return 'CRITICAL_DRIFT';
}