import { randomUUID } from 'crypto';
export function processReleaseCandidate(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    sourceRevision: input.sourceRevision || null,
    artifactId: input.artifactId || null,
    artifactDigest: input.artifactDigest || null,
    status: input.status || 'PROPOSED',
  };
}
