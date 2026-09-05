export type EnvironmentHealthStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';

export interface EnvironmentHealthInput {
  applicationHealth: string;
  infrastructureHealth: string;
  databaseHealth: string;
  securityHealth: string;
  deploymentHealth: string;
  sloState: string;
  incidentSeverity: string;
  capacity: string;
  costRisk: string;
}

export function evaluateEnvironmentHealth(input: EnvironmentHealthInput): EnvironmentHealthStatus {
  if (input.incidentSeverity === 'CRITICAL' || input.applicationHealth === 'UNHEALTHY' || input.infrastructureHealth === 'UNHEALTHY') return 'CRITICAL';
  if (input.applicationHealth === 'UNKNOWN' || input.infrastructureHealth === 'UNKNOWN') return 'UNKNOWN';
  if (input.applicationHealth === 'DEGRADED' || input.databaseHealth === 'DEGRADED' || input.sloState === 'VIOLATED' || input.capacity === 'EXHAUSTION_RISK') return 'DEGRADED';
  return 'HEALTHY';
}
