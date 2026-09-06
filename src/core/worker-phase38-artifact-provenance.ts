import { randomUUID } from 'crypto';
export function processArtifactProvenance(input: any): any {
  return {
    id: randomUUID(),
    artifactId: input.artifactId,
    digest: input.digest || null,
    buildId: input.buildId || null,
    commitSha: input.commitSha || null,
    repository: input.repository || null,
    pipeline: input.pipeline || null,
    builder: input.builder || null,
    createdAt: input.createdAt || new Date().toISOString(),
    provenanceMetadata: input.provenanceMetadata || {},
    securityFindings: input.securityFindings || [],
    dependencyMetadata: input.dependencyMetadata || {},
    valid: input.mismatch ? false : (input.digest ? true : false),
  };
}
