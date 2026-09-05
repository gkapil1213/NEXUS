import { randomUUID } from 'crypto';

export interface PortfolioExperiment {
  experimentId: string;
  portfolioId: string;
  populationIds: string[];
  action: string;
  hypothesis: string;
  objective: string;
  metrics: string[];
  constraints: string[];
  budget: number;
  status: 'PROPOSED' | 'APPROVED' | 'RUNNING' | 'COMPLETED' | 'REJECTED' | 'FAILED';
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createPortfolioExperiment(
  input: Omit<PortfolioExperiment, 'experimentId' | 'createdAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): PortfolioExperiment {
  const idempotencyKey = input.idempotencyKey ?? `${input.portfolioId}:${input.action}:${input.populationIds.join(',')}`;
  return { experimentId: randomUUID(), ...input, status: 'PROPOSED', createdAt: new Date().toISOString(), idempotencyKey };
}
