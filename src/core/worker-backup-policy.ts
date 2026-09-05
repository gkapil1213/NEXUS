import { randomUUID } from 'crypto';

export interface BackupPolicy {
  policyId: string;
  frequencyHours: number;
  retentionDays: number;
  backupType: 'FULL' | 'INCREMENTAL' | 'SNAPSHOT';
  requiredVerification: boolean;
  encryptionRequired: boolean;
  integrityRequired: boolean;
  geographicRedundancy: boolean;
  fingerprint: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createBackupPolicy(
  input: Omit<BackupPolicy, 'policyId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): BackupPolicy {
  const fingerprint = `${input.frequencyHours}:${input.retentionDays}:${input.backupType}:${input.encryptionRequired}:${input.integrityRequired}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return { policyId: randomUUID(), ...input, fingerprint, createdAt: new Date().toISOString(), idempotencyKey };
}

export function validateBackupPolicy(policy: BackupPolicy): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (policy.frequencyHours <= 0) reasons.push('invalid frequency');
  if (policy.retentionDays <= 0) reasons.push('invalid retention');
  if (policy.encryptionRequired === undefined || policy.integrityRequired === undefined) reasons.push('missing security requirements');
  return { valid: reasons.length === 0, reasons };
}
