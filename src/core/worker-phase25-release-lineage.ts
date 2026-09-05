export interface ReleaseLineageNode {
  version: number;
  releaseId: string;
  artifactId?: string;
  deploymentId?: string;
  timestamp: string;
}

export interface ReleaseLineage {
  releaseId: string;
  nodes: ReleaseLineageNode[];
}

export function addReleaseLineageNode(lineage: ReleaseLineage, node: ReleaseLineageNode): ReleaseLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
