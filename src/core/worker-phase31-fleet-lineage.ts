export interface FleetLineageNode {
  version: number;
  fleetId: string;
  operationId?: string;
  timestamp: string;
}

export interface FleetLineage {
  rootId: string;
  nodes: FleetLineageNode[];
}

export function addFleetLineageNode(lineage: FleetLineage, node: FleetLineageNode): FleetLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
