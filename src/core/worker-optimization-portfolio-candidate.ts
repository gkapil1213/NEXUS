import { randomUUID } from 'crypto';

export interface PortfolioCandidate {
  candidateId: string;
  portfolioId: string;
  sourcePopulations: string[];
  action: string; // e.g., 'promote', 'challenge', 'transfer', 'rebalance'
  reason: string;
  evidence: string[];
  confidence: number;
  impactEstimate: number;
  riskEstimate: number;
  recommendedAction: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createPortfolioCandidate(
  input: Omit<PortfolioCandidate, 'candidateId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): PortfolioCandidate {
  const idempotencyKey = input.idempotencyKey ?? `${input.portfolioId}:${input.action}:${input.sourcePopulations.join(',')}`;
  return { candidateId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
