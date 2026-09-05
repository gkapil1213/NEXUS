export interface StrategyLineageNode {
  generationId: string;
  strategyId: string;
  parentGenerationId: string | null;
  rootStrategyId: string;
  reason: string;
  timestamp: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK' | 'RETIRED';
}

export interface StrategyLineage {
  rootStrategyId: string;
  tenantId: string;
  generations: StrategyLineageNode[];
}

export function addLineageNode(lineage: StrategyLineage, node: StrategyLineageNode): StrategyLineage {
  if (lineage.generations.some(g => g.generationId === node.generationId)) {
    throw new Error(`Duplicate generation ${node.generationId}`);
  }
  if (node.parentGenerationId !== null && !lineage.generations.some(g => g.generationId === node.parentGenerationId)) {
    throw new Error(`Parent generation ${node.parentGenerationId} not found`);
  }
  return { ...lineage, generations: [...lineage.generations, node] };
}

export function getActiveGeneration(lineage: StrategyLineage): StrategyLineageNode | null {
  return lineage.generations.find(g => g.status === 'ACTIVE') ?? null;
}

export function getGenerationChain(lineage: StrategyLineage, generationId: string): StrategyLineageNode[] {
  const chain: StrategyLineageNode[] = [];
  let current = lineage.generations.find(g => g.generationId === generationId);
  while (current) {
    chain.unshift(current);
    current = current.parentGenerationId ? lineage.generations.find(g => g.generationId === current!.parentGenerationId) : undefined;
  }
  return chain;
}
