export interface IncidentCluster {
  clusterId: string;
  incidentIds: string[];
  createdAt: string;
  idempotencyKey: string;
}

export function createIncidentCluster(incidentIds: string[]): IncidentCluster {
  return { clusterId: `cluster-${incidentIds.join('-')}`, incidentIds, createdAt: new Date().toISOString(), idempotencyKey: incidentIds.sort().join(',') };
}
