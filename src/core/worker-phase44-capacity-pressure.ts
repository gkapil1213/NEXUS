import { randomUUID } from 'crypto';
export function processCapacityPressure(input: any): any {
  let pressure = 'unknown';
  if (input.utilization !== undefined && input.headroom !== undefined) {
    if (input.utilization > 75 || input.headroom < 25) pressure = 'high';
    else if (input.utilization > 55) pressure = 'medium';
    else pressure = 'low';
  }
  return { id: randomUUID(), resourceId: input.resourceId, pressure, evidence: input.evidence || [] };
}
