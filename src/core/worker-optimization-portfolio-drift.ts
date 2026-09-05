export interface DriftInput {
  strategyDrift: number;
  executionDrift: number;
  effectivenessDrift: number;
  riskDrift: number;
  resourceDrift: number;
  compositionDrift: number;
  evidenceDrift: number;
}

export function detectDrift(input: DriftInput): { severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; driftDetected: boolean } {
  const max = Math.max(input.strategyDrift, input.executionDrift, input.effectivenessDrift, input.riskDrift, input.resourceDrift, input.compositionDrift, input.evidenceDrift);
  if (max < 0.05) return { severity: 'NONE', driftDetected: false };
  if (max < 0.2) return { severity: 'LOW', driftDetected: true };
  if (max < 0.5) return { severity: 'MEDIUM', driftDetected: true };
  if (max < 0.8) return { severity: 'HIGH', driftDetected: true };
  return { severity: 'CRITICAL', driftDetected: true };
}
