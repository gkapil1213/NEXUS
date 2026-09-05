export interface MetaLineageNode {
  methodId: string;
  parentMethodId: string | null;
  version: number;
  reason: string;
  timestamp: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'RETIRED';
}

export interface MetaLineage {
  rootMethodId: string;
  nodes: MetaLineageNode[];
}

export function addMetaLineageNode(lineage: MetaLineage, node: MetaLineageNode): MetaLineage {
  if (lineage.nodes.some(n => n.methodId === node.methodId && n.version === node.version)) {
    throw new Error(`Duplicate lineage node ${node.methodId} v${node.version}`);
  }
  if (node.parentMethodId !== null && !lineage.nodes.some(n => n.methodId === node.parentMethodId)) {
    throw new Error(`Parent method ${node.parentMethodId} not found`);
  }
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
