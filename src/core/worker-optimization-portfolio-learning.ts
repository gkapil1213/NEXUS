export interface PortfolioLearningRecord {
  tenantId: string;
  portfolioId: string;
  sourcePopulationId: string;
  targetPopulationId: string;
  strategyId: string;
  transferredKnowledge: string;
  evidence: string[];
  confidence: number;
  decision: string;
  outcome: string;
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createPortfolioLearningRecord(
  input: Omit<PortfolioLearningRecord, 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): PortfolioLearningRecord {
  const idempotencyKey = input.idempotencyKey ?? `${input.portfolioId}:${input.sourcePopulationId}:${input.targetPopulationId}:${input.strategyId}`;
  return { ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
