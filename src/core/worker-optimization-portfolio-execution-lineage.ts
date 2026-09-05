export interface ExecutionLineageNode {
  version: number;
  portfolioVersion: number;
  strategyId: string;
  strategyGenerationId: string;
  populationId: string;
  experimentId?: string;
  metaExperimentId?: string;
  planId: string;
  executionId: string;
  outcomeId?: string;
  adaptationId?: string;
  reason: string;
  timestamp: string;
}

export interface ExecutionLineage {
  portfolioId: string;
  nodes: ExecutionLineageNode[];
}

export function addExecutionLineageNode(lineage: ExecutionLineage, node: ExecutionLineageNode): ExecutionLineage {
  if (lineage.nodes.some(n => n.version === node.version)) throw new Error(`Version ${node.version} already exists`);
  return { ...lineage, nodes: [...lineage.nodes, node] };
}
