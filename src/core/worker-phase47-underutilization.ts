import { randomUUID } from 'crypto';
export function processUnderutilization(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    utilization: input.utilization,
    state: input.utilization !== undefined ? (input.utilization < (input.threshold || 30) ? 'underutilized' : 'normal') : 'unknown',
  };
}
