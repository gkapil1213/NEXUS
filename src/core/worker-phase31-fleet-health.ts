export type FleetHealthStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';

export interface FleetHealthInput {
  applicationHealth: string;
  infrastructureHealth: string;
  databaseHealth: string;
  securityHealth: string;
  dependencyHealth: string;
  deploymentHealth: string;
  incidentSeverity: string;
  capacity: string;
  costRisk: string;
}

export function evaluateFleetHealth(input: FleetHealthInput): FleetHealthStatus {
  if (input.incidentSeverity === 'CRITICAL' || input.applicationHealth === 'UNHEALTHY' || input.infrastructureHealth === 'UNHEALTHY') return 'CRITICAL';
  if (input.applicationHealth === 'UNKNOWN' || input.infrastructureHealth === 'UNKNOWN') return 'UNKNOWN';
  if (input.applicationHealth === 'DEGRADED' || input.databaseHealth === 'DEGRADED' || input.dependencyHealth === 'DEGRADED' || input.capacity === 'EXHAUSTION_RISK') return 'DEGRADED';
  return 'HEALTHY';
}
