export type CapacityClassification = 'UNDER_CAPACITY' | 'HEALTHY_CAPACITY' | 'OVER_PROVISIONED' | 'UNKNOWN_CAPACITY';

export interface CapacityInput {
  currentUtilization: number;
  allocatedCapacity: number;
  utilizedCapacity: number;
  minUtilization: number;
  maxUtilization: number;
}

export function classifyCapacity(input: CapacityInput): CapacityClassification {
  if (input.currentUtilization === undefined || input.allocatedCapacity === undefined) return 'UNKNOWN_CAPACITY';
  const utilization = input.utilizedCapacity / Math.max(input.allocatedCapacity, 1);
  if (utilization < input.minUtilization) return 'OVER_PROVISIONED';
  if (utilization > input.maxUtilization) return 'UNDER_CAPACITY';
  return 'HEALTHY_CAPACITY';
}
