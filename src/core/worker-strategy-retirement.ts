import { randomUUID } from 'crypto';

export type RetirementDecision = 'RETIRE' | 'KEEP' | 'REINSTATE' | 'REVIEW';

export interface RetirementCandidateInput {
  strategyId: string;
  tenantId: string;
  evidenceRefs: string[];
  repeatedRegression: boolean;
  persistentLowEffectiveness: boolean;
  excessiveCost: boolean;
  excessiveRisk: boolean;
  obsoleteAssumptions: boolean;
  environmentalIncompatibility: boolean;
  superiorStrategyExists: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  governanceDecision: string;
  rollbackPath: string;
  correlationId: string;
}

export function evaluateRetirementCandidate(input: RetirementCandidateInput): RetirementDecision {
  if (input.governanceDecision !== 'ALLOW') return 'REVIEW';
  if (input.repeatedRegression || input.persistentLowEffectiveness || input.excessiveRisk || input.environmentalIncompatibility) {
    return 'RETIRE';
  }
  if (input.obsoleteAssumptions && input.superiorStrategyExists) return 'RETIRE';
  if (input.excessiveCost && input.confidence !== 'HIGH') return 'RETIRE';
  return 'KEEP';
}
