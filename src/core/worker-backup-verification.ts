export type BackupVerificationStatus = 'VERIFIED' | 'FAILED' | 'CORRUPTED' | 'UNAVAILABLE' | 'UNKNOWN';

export interface BackupVerificationInput {
  artifact: { checksum: string };
  expectedChecksum?: string;
  providerAvailable: boolean;
}

export function verifyBackup(input: BackupVerificationInput): BackupVerificationStatus {
  if (!input.providerAvailable) return 'UNAVAILABLE';
  if (!input.expectedChecksum) return 'UNKNOWN';
  return input.artifact.checksum === input.expectedChecksum ? 'VERIFIED' : 'CORRUPTED';
}
