import { randomUUID } from 'crypto';
export function processVersionConsistency(input: any): any {
  const consistent = !input.mismatch;
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    applicationId: input.applicationId || null,
    expectedVersion: input.expectedVersion || null,
    artifactVersion: input.artifactVersion || null,
    targetVersion: input.targetVersion || null,
    consistent,
    details: input.details || null,
  };
}
