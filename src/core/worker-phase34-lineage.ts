export interface LineageNode {
  version: number;
  identityId: string;
  operationId?: string;
  timestamp: string;
}

export interface Lineage {
  rootId: string;
  nodes: LineageNode[];
}

export function addLineageNode(lineage: Lineage, node: LineageNode): Lineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
