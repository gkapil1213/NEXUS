import { createHash, randomUUID } from 'crypto';

export interface BackupArtifact {
  artifactId: string;
  jobId: string;
  checksum: string;
  size: number;
  providerReference: string;
  encryptionMetadata: string;
  createdAt: string;
  lineage: string[];
  retentionState: string;
  idempotencyKey: string;
}

export function createBackupArtifact(
  input: Omit<BackupArtifact, 'artifactId' | 'createdAt' | 'checksum' | 'idempotencyKey'> & { idempotencyKey?: string }
): BackupArtifact {
  const checksum = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const idempotencyKey = input.idempotencyKey ?? checksum;
  return { artifactId: randomUUID(), ...input, checksum, createdAt: new Date().toISOString(), idempotencyKey };
}
