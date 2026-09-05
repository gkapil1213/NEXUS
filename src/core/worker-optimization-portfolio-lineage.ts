export interface PortfolioVersionNode {
  version: string;
  parentVersion: string | null;
  reason: string;
  candidateIds: string[];
  experimentIds: string[];
  correlationId: string;
  timestamp: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK' | 'REJECTED';
}

export interface PortfolioLineage {
  portfolioId: string;
  tenantId: string;
  versions: PortfolioVersionNode[];
}

export function addPortfolioVersion(lineage: PortfolioLineage, node: PortfolioVersionNode): PortfolioLineage {
  if (node.parentVersion !== null && !lineage.versions.some(v => v.version === node.parentVersion)) {
    throw new Error(`Parent version ${node.parentVersion} not found`);
  }
  if (lineage.versions.some(v => v.version === node.version)) {
    throw new Error(`Version ${node.version} already exists`);
  }
  return { ...lineage, versions: [...lineage.versions, node] };
}

export function getActivePortfolioVersion(lineage: PortfolioLineage): PortfolioVersionNode | null {
  return lineage.versions.find(v => v.status === 'ACTIVE') ?? null;
}
