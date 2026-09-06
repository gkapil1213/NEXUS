import { randomUUID } from 'crypto';
export function processCapacityState(input: any): any {
  let state = 'unknown';
  if (input.utilization !== undefined && input.headroom !== undefined) {
    if (input.utilization < 30) state = 'under_utilized';
    else if (input.utilization < 70) state = 'healthy';
    else if (input.utilization < 90) state = 'pressured';
    else if (input.utilization >= 100 || input.headroom <= 0) state = 'exhausted';
    else state = 'at_risk';
  }
  return { id: randomUUID(), resourceId: input.resourceId, capacityState: state, headroom: input.headroom };
}
