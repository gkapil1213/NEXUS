export type ShadowStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'REJECTED';

export interface ShadowEvaluation {
  evaluationId: string;
  candidateId: string;
  parentGenerationId: string;
  tenantId: string;
  status: ShadowStatus;
  baselineMetrics: Record<string, number>;
  candidateMetrics: Record<string, number>;
  outcome: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA';
  evidence: string[];
  startedAt?: string;
  completedAt?: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createShadowEvaluation(
  input: Omit<ShadowEvaluation, 'evaluationId' | 'status' | 'createdAt' | 'idempotencyKey' | 'outcome'> & { idempotencyKey?: string }
): ShadowEvaluation {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.candidateId}`;
  return {
    evaluationId: `shadow-${input.candidateId}-${Date.now()}`,
    ...input,
    status: 'PENDING',
    outcome: 'INSUFFICIENT_DATA',
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}

export function completeShadowEvaluation(
  evaluation: ShadowEvaluation,
  baselineMetrics: Record<string, number>,
  candidateMetrics: Record<string, number>,
  outcome: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
): ShadowEvaluation {
  return {
    ...evaluation,
    baselineMetrics,
    candidateMetrics,
    outcome,
    status: outcome === 'FAIL' ? 'REJECTED' : 'COMPLETED',
    completedAt: new Date().toISOString(),
  };
}
