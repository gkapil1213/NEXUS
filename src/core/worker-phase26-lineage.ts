export interface OperationalLineageNode {
  version: number;
  incidentId: string;
  remediationId?: string;
  evidenceId?: string;
  timestamp: string;
}

export interface OperationalLineage {
  rootId: string;
  nodes: OperationalLineageNode[];
}

export function addOperationalLineageNode(lineage: OperationalLineage, node: OperationalLineageNode): OperationalLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
