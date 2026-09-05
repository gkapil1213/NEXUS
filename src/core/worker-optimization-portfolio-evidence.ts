export interface PortfolioEvidence {
  evidenceId: string;
  portfolioId: string;
  sourcePopulationId: string;
  targetPopulationId: string;
  outcome: Record<string, number>;
  confidence: number;
  evidenceType: 'POSITIVE' | 'NEGATIVE' | 'CONFLICTING' | 'INSUFFICIENT';
  sampleSize: number;
  durability: number;
  timestamp: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createPortfolioEvidence(
  input: Omit<PortfolioEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): PortfolioEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.portfolioId}:${input.sourcePopulationId}:${input.targetPopulationId}:${input.correlationId}`;
  return { evidenceId: `${input.portfolioId}-${Date.now()}`, ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
