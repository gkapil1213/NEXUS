export interface StrategyLineageNode {
  version: string;
  parentVersion: string | null;
  strategyId: string;
  candidateIds: string[];
  portfolioIds: string[];
  experimentIds: string[];
  policyIds: string[];
  evidenceRefs: string[];
  reason: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK' | 'REJECTED';
  timestamp: string;
}

export interface StrategyLineage {
  strategyId: string;
  tenantId: string;
  versions: StrategyLineageNode[];
}

export function addStrategyLineageVersion(lineage: StrategyLineage, node: StrategyLineageNode): StrategyLineage {
  if (node.parentVersion !== null && !lineage.versions.some(v => v.version === node.parentVersion)) {
    throw new Error(`Parent version ${node.parentVersion} not found`);
  }
  if (lineage.versions.some(v => v.version === node.version)) {
    throw new Error(`Version ${node.version} already exists`);
  }
  return { ...lineage, versions: [...lineage.versions, node] };
}

export function getActiveStrategyVersion(lineage: StrategyLineage): StrategyLineageNode | null {
  return lineage.versions.find(v => v.status === 'ACTIVE') ?? null;
}
