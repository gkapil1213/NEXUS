import { randomUUID } from 'crypto';
export function processBaseline(input: any): any {
  let deviation = null;
  if (input.currentValue !== undefined && input.baselineValue !== undefined && input.deviationThreshold !== undefined) {
    deviation = Math.abs(input.currentValue - input.baselineValue) > input.deviationThreshold;
  }
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    baselineValue: input.baselineValue,
    minValue: input.minValue || null,
    maxValue: input.maxValue || null,
    windowSeconds: input.windowSeconds || null,
    deviationThreshold: input.deviationThreshold || null,
    deviationDetected: deviation,
  };
}
