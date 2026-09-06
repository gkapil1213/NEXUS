import { randomUUID } from 'crypto';

export function processDependencyGraph(input: any): any {
  const result: any = {
    id: randomUUID(),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetType: input.targetType,
    targetId: input.targetId,
  };
  if (input.validate) result.valid = true;
  if (input.analyzeImpact) result.impact = { affected: [] };
  return result;
}
