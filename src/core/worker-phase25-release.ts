import { randomUUID } from 'crypto';

export interface Release {
  releaseId: string;
  name: string;
  version: string;
  artifactId?: string;
  sourceCommit: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRelease(
  input: Omit<Release, 'releaseId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): Release {
  const idempotencyKey = input.idempotencyKey ?? `${input.name}:${input.version}:${input.sourceCommit}`;
  return { releaseId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
