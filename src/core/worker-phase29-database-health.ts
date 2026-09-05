export type DatabaseHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface DatabaseHealthInput {
  availability: number;
  connectionSaturation: number;
  errorRate: number;
  latency: number;
  storageUtilization: number;
  replicationLag: number;
  lockContention: number;
  deadlocks: number;
  dataFreshness: number;
  integrityViolations: number;
}

export function evaluateDatabaseHealth(input: DatabaseHealthInput): DatabaseHealthStatus {
  if (input.availability === 0) return 'UNKNOWN';
  if (input.availability < 0.9 || input.errorRate > 0.05 || input.storageUtilization > 0.9 || input.lockContention > 0.8 || input.deadlocks > 3 || input.integrityViolations > 0) return 'UNHEALTHY';
  if (input.connectionSaturation > 0.8 || input.latency > 500 || input.replicationLag > 30 || input.dataFreshness < 0.5) return 'DEGRADED';
  return 'HEALTHY';
}
