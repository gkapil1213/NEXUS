import { randomUUID } from 'crypto';
export function processRelease(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    projectId: input.projectId || null,
    applicationId: input.applicationId || null,
    name: input.name,
    version: input.version,
    commitSha: input.commitSha || null,
    artifactId: input.artifactId || null,
    sourceEnvironment: input.sourceEnvironment || null,
    targetEnvironment: input.targetEnvironment || null,
    status: input.status || 'DRAFT',
    risk: input.risk || 'UNKNOWN',
    strategy: input.strategy || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
