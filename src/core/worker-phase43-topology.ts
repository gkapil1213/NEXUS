import { randomUUID } from 'crypto';
export function processTopology(input: any): any {
  return { id: randomUUID(), sourceType: input.sourceType, sourceId: input.sourceId, targetType: input.targetType, targetId: input.targetId, relationship: input.relationship || 'depends_on' };
}
