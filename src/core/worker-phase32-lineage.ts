export interface GovernanceLineageNode {
  version: number;
  decisionId: string;
  operationId?: string;
  timestamp: string;
}

export interface GovernanceLineage {
  rootId: string;
  nodes: GovernanceLineageNode[];
}

export function addGovernanceLineageNode(lineage: GovernanceLineage, node: GovernanceLineageNode): GovernanceLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
