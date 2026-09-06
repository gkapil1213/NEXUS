import { randomUUID } from 'crypto';
export function processLineage(input: any): any {
  return { id: randomUUID(), resourceId: input.resourceId, observationId: input.observationId || null, assessmentId: input.assessmentId || null, planId: input.planId || null, executionId: input.executionId || null, rollbackId: input.rollbackId || null, evidenceId: input.evidenceId || null, learningOutcomeId: input.learningOutcomeId || null };
}
