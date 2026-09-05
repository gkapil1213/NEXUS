export interface RecoveryReadinessInput {
  validRecoveryPlan: boolean;
  validBackupPolicy: boolean;
  recentVerifiedBackup: boolean;
  validRecoveryPoint: boolean;
  restoreCapability: boolean;
  failoverCapability: boolean;
  dependenciesReady: boolean;
  governanceReady: boolean;
  securityReady: boolean;
  verificationCapability: boolean;
}

export function evaluateRecoveryReadiness(input: RecoveryReadinessInput): 'READY' | 'DEGRADED' | 'NOT_READY' | 'UNKNOWN' {
  if (!input.validRecoveryPlan || !input.validBackupPolicy || !input.restoreCapability || !input.failoverCapability) return 'NOT_READY';
  if (!input.recentVerifiedBackup || !input.validRecoveryPoint) return 'DEGRADED';
  if (!input.dependenciesReady || !input.governanceReady || !input.securityReady) return 'DEGRADED';
  if (!input.verificationCapability) return 'UNKNOWN';
  return 'READY';
}
