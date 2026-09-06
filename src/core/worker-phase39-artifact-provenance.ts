import { randomUUID } from 'crypto';
export function processArtifactProvenance(input: any): any {
  const valid = !input.mismatch && input.digest ? true : false;
  return {
    id: randomUUID(),
    artifactId: input.artifactId,
    digest: input.digest || null,
    sourceCommit: input.sourceCommit || null,
    buildId: input.buildId || null,
    pipeline: input.pipeline || null,
    createdAt: input.createdAt || new Date().toISOString(),
    provenanceMetadata: input.provenanceMetadata || {},
    valid,
  };
}
