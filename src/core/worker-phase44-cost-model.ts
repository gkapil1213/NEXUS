import { randomUUID } from 'crypto';
export function processCostModel(input: any): any {
  if (input.unknownCost) return { id: randomUUID(), resourceId: input.resourceId, costAvailable: false };
  return { id: randomUUID(), resourceId: input.resourceId, costAvailable: true, currentCost: input.currentCost || 0, projectedCost: input.projectedCost || 0, incrementalCost: input.incrementalCost || 0, estimatedSavings: input.estimatedSavings || 0, costConfidence: input.costConfidence || 0 };
}
