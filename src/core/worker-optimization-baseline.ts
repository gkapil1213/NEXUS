import { randomUUID } from 'crypto';

export interface OptimizationBaseline {
  baselineId: string;
  tenantId: string;
  hypothesisId: string;
  baselineVersion: string;
  baselineWindow: { start: string; end: string };
  metrics: Record<string, number>;
  telemetryFreshness: 'FRESH' | 'STALE';
  policyVersion: string;
  fleetState: string;
  incidentState: string;
  releaseState: string;
  capturedAt: string;
  correlationId: string;
}

export function captureOptimizationBaseline(
  input: Omit<OptimizationBaseline, 'baselineId' | 'capturedAt'>
): OptimizationBaseline {
  return {
    baselineId: randomUUID(),
    ...input,
    capturedAt: new Date().toISOString(),
  };
}
