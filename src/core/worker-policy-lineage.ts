export interface PolicyVersionNode {
  version: string;
  parentVersion: string | null;
  reason: string;
  evidenceIds: string[];
  proposalId?: string;
  authorizationId?: string;
  rolloutId?: string;
  outcome?: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK' | 'REJECTED' | 'PROPOSED';
  timestamp: string;
}

export interface PolicyLineage {
  policyId: string;
  tenantId: string;
  versions: PolicyVersionNode[];
}

export function addVersionToLineage(
  lineage: PolicyLineage,
  newNode: PolicyVersionNode
): PolicyLineage {
  if (newNode.parentVersion !== null) {
    const parentExists = lineage.versions.some(v => v.version === newNode.parentVersion);
    if (!parentExists) {
      throw new Error(`Parent version ${newNode.parentVersion} not found`);
    }
  }
  if (lineage.versions.some(v => v.version === newNode.version)) {
    throw new Error(`Version ${newNode.version} already exists`);
  }
  return {
    ...lineage,
    versions: [...lineage.versions, newNode],
  };
}

export function getActiveVersion(lineage: PolicyLineage): PolicyVersionNode | null {
  return lineage.versions.find(v => v.status === 'ACTIVE') ?? null;
}

export function getVersionHistory(lineage: PolicyLineage): PolicyVersionNode[] {
  return [...lineage.versions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
