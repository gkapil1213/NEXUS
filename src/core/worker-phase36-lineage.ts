import { randomUUID } from 'crypto';
export function processLineage(input: any): any {
  return { id: randomUUID(), releaseId: input.releaseId, commitSha: input.commitSha, pipelineId: input.pipelineId, buildId: input.buildId };
}
