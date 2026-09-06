import { randomUUID } from 'crypto';
export function processReleaseCandidate(input: any): any {
  return {
    id: input.idempotencyKey || randomUUID(),
    releaseId: input.releaseId,
    sourceRevision: input.sourceRevision,
    changedFiles: input.changedFiles || null,
    affectedServices: input.affectedServices || null,
  };
}
