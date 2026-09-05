import { createStrategyCandidate, StrategyCandidate } from './worker-optimization-strategy-candidate';
import { scoreStrategy } from './worker-optimization-strategy-scoring';

export interface SynthesisInput {
  tenantId: string;
  strategyId: string;
  objectiveImpacts: Record<string, number>;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  evidenceRefs: string[];
  resourceRequirements: Record<string, number>;
  interactionEffects: Record<string, number>;
  evidenceQuality: number;
  durabilityFactor: number;
  interactionFactor: number;
  riskPenalty: number;
  resourcePenalty: number;
  correlationId: string;
}

export function synthesizeStrategyCandidate(input: SynthesisInput): StrategyCandidate {
  const candidate = createStrategyCandidate({
    tenantId: input.tenantId,
    strategyId: input.strategyId,
    objectiveImpacts: input.objectiveImpacts,
    expectedBenefit: Object.values(input.objectiveImpacts).reduce((s, v) => s + v, 0),
    confidence: input.confidence,
    risk: input.risk,
    evidenceRefs: input.evidenceRefs,
    resourceRequirements: input.resourceRequirements,
    interactionEffects: input.interactionEffects,
    correlationId: input.correlationId,
  });

  // Attach score (we don't store score in candidate, but we can return it separately if needed)
  return candidate;
}
