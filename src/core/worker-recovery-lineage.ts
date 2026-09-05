export interface RecoveryLineageNode {
  version: number;
  incidentId?: string;
  recoveryDecision?: string;
  recoveryPointId?: string;
  backupArtifactId?: string;
  restoreId?: string;
  failoverId?: string;
  timestamp: string;
}

export interface RecoveryLineage {
  rootId: string;
  nodes: RecoveryLineageNode[];
}

export function addRecoveryLineageNode(lineage: RecoveryLineage, node: RecoveryLineageNode): RecoveryLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
