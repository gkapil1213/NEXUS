import { randomUUID } from 'crypto';
export function processReleaseLineage(input: any): any {
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    sourceChange: input.sourceChange || null,
    commitSha: input.commitSha || null,
    buildId: input.buildId || null,
    artifactId: input.artifactId || null,
    environmentId: input.environmentId || null,
    executionId: input.executionId || null,
    incidentId: input.incidentId || null,
    createdAt: new Date().toISOString(),
  };
}
