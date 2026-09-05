export interface SecurityLineageNode {
  version: number;
  incidentId: string;
  signalId?: string;
  detectionId?: string;
  remediationId?: string;
  timestamp: string;
}

export interface SecurityLineage {
  rootId: string;
  nodes: SecurityLineageNode[];
}

export function addSecurityLineageNode(lineage: SecurityLineage, node: SecurityLineageNode): SecurityLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
