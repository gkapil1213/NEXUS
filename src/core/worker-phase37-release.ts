import { randomUUID } from 'crypto';
export function processRelease(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    name: input.name,
    version: input.version,
    sourceRevision: input.sourceRevision || null,
    artifactId: input.artifactId || null,
    artifactDigest: input.artifactDigest || null,
    environmentTarget: input.environmentTarget || null,
    status: input.status || 'DRAFT',
  };
}
