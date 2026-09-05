export interface InfrastructureLineageNode {
  version: number;
  resourceId: string;
  opportunityId?: string;
  executionId?: string;
  timestamp: string;
}

export interface InfrastructureLineage {
  rootId: string;
  nodes: InfrastructureLineageNode[];
}

export function addInfrastructureLineageNode(lineage: InfrastructureLineage, node: InfrastructureLineageNode): InfrastructureLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
