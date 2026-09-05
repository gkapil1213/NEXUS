import { createHash, randomUUID } from 'crypto';

export interface Artifact {
  artifactId: string;
  pipelineExecutionId: string;
  sourceRevision: string;
  buildFingerprint: string;
  fingerprint: string;
  type: string;
  size: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createArtifact(
  input: Omit<Artifact, 'artifactId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): Artifact {
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return {
    artifactId: randomUUID(),
    ...input,
    fingerprint,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}

export function verifyArtifactIntegrity(artifact: Artifact, expectedFingerprint: string): boolean {
  return artifact.fingerprint === expectedFingerprint;
}
