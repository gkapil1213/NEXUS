export function evaluateHealthGate(health: string, errorRate: number, latency: number, slo: string, incidents: number, securityFindings: number, capacity: string, databaseHealth: string, dependencyHealth: string, configDrift: string): 'PASS' | 'HALT' | 'UNKNOWN' {
  if (health === 'UNKNOWN' || slo === 'UNKNOWN') return 'UNKNOWN';
  if (health === 'UNHEALTHY' || incidents > 0 || securityFindings > 0 || configDrift === 'HIGH') return 'HALT';
  if (slo === 'VIOLATED' || capacity === 'EXHAUSTION_RISK') return 'HALT';
  return 'PASS';
}
