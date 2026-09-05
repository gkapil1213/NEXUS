export type ConnectionHealthStatus = 'HEALTHY' | 'WARNING' | 'SATURATED' | 'UNKNOWN';

export interface ConnectionHealthInput {
  maxConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
}

export function evaluateConnectionHealth(input: ConnectionHealthInput): ConnectionHealthStatus {
  if (input.maxConnections === 0) return 'UNKNOWN';
  const utilization = (input.activeConnections + input.waitingConnections) / input.maxConnections;
  if (utilization > 0.9) return 'SATURATED';
  if (utilization > 0.7) return 'WARNING';
  return 'HEALTHY';
}
