export interface ReleaseRiskInput {
  changedFiles: number;
  sensitiveFiles: boolean;
  databaseMigration: boolean;
  infrastructureChange: boolean;
  dependencyChange: boolean;
  securityChange: boolean;
  testFailures: number;
  historicalInstability: number;
  blastRadius: number;
}

export function classifyReleaseRisk(input: ReleaseRiskInput): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  let score = 0;
  score += input.changedFiles > 50 ? 2 : input.changedFiles > 20 ? 1 : 0;
  if (input.sensitiveFiles) score += 2;
  if (input.databaseMigration) score += 2;
  if (input.infrastructureChange) score += 2;
  if (input.dependencyChange) score += 1;
  if (input.securityChange) score += 5;
  score += input.testFailures * 2;
  score += input.historicalInstability * 2;
  score += input.blastRadius;
  if (score >= 8) return 'CRITICAL';
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MEDIUM';
  return 'LOW';
}
