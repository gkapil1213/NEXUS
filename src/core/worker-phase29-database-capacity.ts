export type CapacityClassification = 'HEALTHY_CAPACITY' | 'WARNING' | 'AT_RISK' | 'EXHAUSTION_RISK' | 'UNKNOWN';

export interface CapacityInput {
  storageUtilization: number;
  connectionUtilization: number;
  computePressure: number;
  growthRate: number;
  capacityThreshold: number;
}

export function classifyCapacity(input: CapacityInput): CapacityClassification {
  if (input.storageUtilization === undefined || input.connectionUtilization === undefined) return 'UNKNOWN';
  if (input.storageUtilization > input.capacityThreshold || input.connectionUtilization > 0.9 || input.computePressure > 0.9) return 'EXHAUSTION_RISK';
  if (input.storageUtilization > input.capacityThreshold * 0.8 || input.growthRate > 0.1) return 'AT_RISK';
  if (input.growthRate > 0.05) return 'WARNING';
  return 'HEALTHY_CAPACITY';
}

export function forecastCapacity(current: number, growthRate: number, days: number): { projected: number; confidence: number } {
  return { projected: current * (1 + growthRate * days), confidence: Math.max(0, 1 - growthRate * 10) };
}
