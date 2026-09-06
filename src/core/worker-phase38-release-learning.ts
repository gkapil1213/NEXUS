import { randomUUID } from 'crypto';
export function processReleaseLearning(input: any): any {
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    predictedRisk: input.predictedRisk || null,
    actualRisk: input.actualRisk || null,
    outcome: input.outcome || 'success',
    recommendation: input.recommendation || '',
    createdAt: new Date().toISOString(),
  };
}
