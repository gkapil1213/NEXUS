export type ReplicationHealthStatus = 'HEALTHY' | 'DEGRADED' | 'AT_RISK' | 'UNAVAILABLE' | 'UNKNOWN';

export interface ReplicationHealthInput {
  replicationState: string;
  replicaAvailability: number;
  replicationLag: number;
  syncStatus: boolean;
  replicaCount: number;
  failoverReady: boolean;
}

export function evaluateReplicationHealth(input: ReplicationHealthInput): ReplicationHealthStatus {
  if (input.replicationState === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (input.replicationState === 'UNKNOWN') return 'UNKNOWN';
  if (!input.syncStatus || input.replicationLag > 60) return 'AT_RISK';
  if (input.replicaAvailability < 0.9 || !input.failoverReady) return 'DEGRADED';
  return 'HEALTHY';
}
