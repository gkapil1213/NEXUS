export interface ProductionLineageNode {
  version: number;
  requestId: string;
  releaseId?: string;
  executionId?: string;
  environmentId: string;
  timestamp: string;
}

export interface ProductionLineage {
  environmentId: string;
  nodes: ProductionLineageNode[];
}

export function addProductionLineageNode(lineage: ProductionLineage, node: ProductionLineageNode): ProductionLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
