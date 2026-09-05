export interface RecoveryPoint {
  pointId: string;
  source: string;
  timestamp: string;
  backupArtifactId: string;
  verificationState: string;
  retentionState: string;
  recoveryReadiness: string;
}

export function createRecoveryPoint(
  input: Omit<RecoveryPoint, 'pointId'>
): RecoveryPoint {
  return { pointId: `rp-${Date.now()}-${Math.random()}`, ...input };
}
