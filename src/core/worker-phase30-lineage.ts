export interface RuntimeLineageNode {
  version: number;
  serviceId: string;
  operationId?: string;
  timestamp: string;
}

export interface RuntimeLineage {
  rootId: string;
  nodes: RuntimeLineageNode[];
}

export function addRuntimeLineageNode(lineage: RuntimeLineage, node: RuntimeLineageNode): RuntimeLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
