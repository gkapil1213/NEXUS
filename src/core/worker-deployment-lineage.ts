export interface DeploymentLineageNode {
  version: number;
  releaseId: string;
  artifactId: string;
  targetId: string;
  deploymentId: string;
  timestamp: string;
}

export interface DeploymentLineage {
  rootId: string;
  nodes: DeploymentLineageNode[];
}

export function addDeploymentLineageNode(lineage: DeploymentLineage, node: DeploymentLineageNode): DeploymentLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
