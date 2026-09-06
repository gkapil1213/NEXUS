import { randomUUID } from 'crypto';
export function processUtilization(input: any): any {
  let headroom = null;
  if (input.currentUtilization !== undefined && input.maxCapacity !== undefined) {
    headroom = input.maxCapacity - input.currentUtilization;
  }
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    currentUtilization: input.currentUtilization,
    avgUtilization: input.avgUtilization || null,
    peakUtilization: input.peakUtilization || null,
    minUtilization: input.minUtilization || null,
    variance: input.variance || null,
    trend: input.trend || 'unknown',
    headroom,
  };
}
