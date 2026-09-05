export interface DataLineageNode {
  version: number;
  resourceId: string;
  operationId?: string;
  timestamp: string;
}

export interface DataLineage {
  rootId: string;
  nodes: DataLineageNode[];
}

export function addDataLineageNode(lineage: DataLineage, node: DataLineageNode): DataLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
