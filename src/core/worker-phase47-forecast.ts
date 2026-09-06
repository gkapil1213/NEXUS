import { randomUUID } from 'crypto';
export function processForecast(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    horizon: input.horizon || '1h',
    predictedValue: input.predictedValue || 0,
    confidence: input.confidence || 0,
    evidence: input.evidence || [],
    modelMethod: input.modelMethod || 'deterministic',
    generatedAt: new Date().toISOString(),
  };
}
