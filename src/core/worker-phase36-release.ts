import { randomUUID } from 'crypto';
export function processRelease(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    idempotency_key: input.idempotencyKey || id,
    name: input.name,
    version: input.version,
    source_revision: input.sourceRevision || null,
    artifact_refs: input.artifactRefs || null,
    pipeline_id: input.pipelineId || null,
    environment_target: input.environmentTarget || null,
    classification: input.classification || 'UNKNOWN',
    status: input.status || 'DRAFT',
  };
}
