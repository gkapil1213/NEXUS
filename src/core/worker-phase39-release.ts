import { randomUUID } from 'crypto';
export function processRelease(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    applicationId: input.applicationId || null,
    serviceId: input.serviceId || null,
    environment: input.environment || null,
    version: input.version,
    name: input.name || null,
    sourceRevision: input.sourceRevision || null,
    artifactId: input.artifactId || null,
    artifactFingerprint: input.artifactFingerprint || null,
    releaseType: input.releaseType || 'standard',
    strategy: input.strategy || null,
    state: input.state || 'candidate',
    riskLevel: input.riskLevel || 'UNKNOWN',
    metadata: input.metadata || {},
  };
}
