export type MigrationSafetyClassification = 'SAFE' | 'REQUIRES_APPROVAL' | 'HIGH_RISK' | 'BLOCKED' | 'UNKNOWN';

export interface MigrationSafetyInput {
  migrationType: string;
  affectedTables: number;
  affectedColumns: number;
  indexes: number;
  constraints: number;
  lockRisk: number;
  dataLossRisk: number;
  backwardCompatible: boolean;
  rollbackAvailable: boolean;
  protectedResource: boolean;
  blastRadius: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function classifyMigrationSafety(input: MigrationSafetyInput): MigrationSafetyClassification {
  if (input.protectedResource && !input.rollbackAvailable) return 'BLOCKED';
  if (input.dataLossRisk > 0.3 || !input.backwardCompatible) return 'HIGH_RISK';
  if (input.lockRisk > 0.5 || input.blastRadius === 'HIGH' || input.blastRadius === 'CRITICAL') return 'REQUIRES_APPROVAL';
  if (input.lockRisk > 0.2 || input.affectedTables > 3) return 'REQUIRES_APPROVAL';
  return 'SAFE';
}
