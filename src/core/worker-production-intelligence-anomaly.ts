import { ProductionSignal } from './worker-production-intelligence-signal';

export type AnomalyStatus = 'NORMAL' | 'WARNING' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';

export interface AnomalyInput {
  signal: ProductionSignal;
  thresholds: { warning: number; critical: number };
}

export function detectAnomaly(input: AnomalyInput): AnomalyStatus {
  const signal = input.signal;
  if (signal.severity === 'UNKNOWN') return 'UNKNOWN';
  const value = signal.observedValue;
  if (value >= input.thresholds.critical) return 'CRITICAL';
  if (value >= input.thresholds.warning) return 'WARNING';
  return 'NORMAL';
}
