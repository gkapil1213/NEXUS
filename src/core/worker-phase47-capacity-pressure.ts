import { randomUUID } from 'crypto';
export function processCapacityPressure(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    utilization: input.utilization,
    threshold: input.threshold || 80,
    state: input.utilization !== undefined ? (input.utilization >= (input.threshold || 80) ? 'pressured' : 'normal') : 'unknown',
  };
}
