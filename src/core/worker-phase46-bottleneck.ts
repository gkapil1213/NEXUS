import { randomUUID } from 'crypto';
export function processBottleneck(input: any): any {
  return { id: randomUUID(), resourceId: input.resourceId, bottleneckType: input.bottleneckType || 'unknown', confidence: input.confidence || 0, evidence: input.evidence || [] };
}
