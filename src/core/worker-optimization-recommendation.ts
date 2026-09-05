import { randomUUID } from 'crypto';

export type RecommendationType = 'RUN' | 'DEFER' | 'HOLD' | 'STOP' | 'REVALIDATE' | 'ROLLBACK' | 'PROMOTE' | 'DO_NOT_REPEAT';

export interface RecommendationInput {
  tenantId: string;
  affectedObjective: string;
  expectedBenefit: number;
  expectedRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  historicalEvidence: string[];
  freshness: 'FRESH' | 'STALE';
  governingPolicy: string;
  decisionLineage: string[];
  fatigueState: string;
  returnClassification: string;
  durability: string;
}

export interface OptimizationRecommendation {
  recommendationId: string;
  recommendationType: RecommendationType;
  reason: string;
  evidence: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  affectedObjective: string;
  expectedBenefit: number;
  expectedRisk: string;
  historicalEvidence: string[];
  freshness: string;
  governingPolicy: string;
  decisionLineage: string[];
  tenantId: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createOptimizationRecommendation(
  input: RecommendationInput,
  correlationId: string,
  idempotencyKey?: string
): OptimizationRecommendation {
  // Deterministic recommendation logic
  let recommendationType: RecommendationType = 'HOLD';
  if (input.freshness === 'STALE' || input.confidence === 'UNKNOWN' || input.confidence === 'LOW') {
    recommendationType = 'DEFER';
  } else if (input.fatigueState === 'THRASHING' || input.fatigueState === 'FROZEN') {
    recommendationType = 'STOP';
  } else if (input.returnClassification === 'OPTIMIZATION_SATURATION' || input.returnClassification === 'NEGATIVE_RETURN') {
    recommendationType = 'STOP';
  } else if (input.expectedRisk === 'CRITICAL' || input.expectedRisk === 'UNKNOWN') {
    recommendationType = 'HOLD';
  } else if (input.durability === 'DURABLE_IMPROVEMENT' && input.expectedBenefit > 0) {
    recommendationType = 'PROMOTE';
  } else if (input.durability === 'REGRESSION') {
    recommendationType = 'ROLLBACK';
  } else if (input.expectedBenefit > 0) {
    recommendationType = 'RUN';
  } else {
    recommendationType = 'DO_NOT_REPEAT';
  }

  return {
    recommendationId: randomUUID(),
    recommendationType,
    reason: `Recommendation based on freshness=${input.freshness}, fatigue=${input.fatigueState}, return=${input.returnClassification}, durability=${input.durability}`,
    evidence: input.historicalEvidence,
    confidence: input.confidence,
    affectedObjective: input.affectedObjective,
    expectedBenefit: input.expectedBenefit,
    expectedRisk: input.expectedRisk,
    historicalEvidence: input.historicalEvidence,
    freshness: input.freshness,
    governingPolicy: input.governingPolicy,
    decisionLineage: input.decisionLineage,
    tenantId: input.tenantId,
    correlationId,
    idempotencyKey: idempotencyKey ?? `${input.tenantId}:${correlationId}`,
    createdAt: new Date().toISOString(),
  };
}
