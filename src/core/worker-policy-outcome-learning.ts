export type OutcomeLearningStatus = 'LEARNED' | 'INSUFFICIENT_DATA' | 'UNKNOWN' | 'CONFLICTED';

export interface OutcomeLearningInput {
  outcome: 'VERIFIED_IMPROVEMENT' | 'VERIFIED_REGRESSION' | 'NO_SIGNIFICANT_CHANGE' | 'CONFLICTED' | 'UNKNOWN' | 'INSUFFICIENT_DATA';
  attributionStatus: 'CAUSALLY_SUPPORTED' | 'CORRELATED' | 'CONFOUNDED' | 'UNKNOWN' | 'INSUFFICIENT_DATA';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  policyCharacteristics: {
    reliability: number;
    cost: number;
    performance: number;
    risk: number;
  };
  environmentalConstraints: string[];
}

export interface PolicyInsight {
  status: OutcomeLearningStatus;
  characteristics: Record<string, number>;
  conditions: string[];
  learnedAt: string;
}

export function learnFromOutcome(input: OutcomeLearningInput): PolicyInsight {
  if (input.outcome === 'INSUFFICIENT_DATA' || input.attributionStatus === 'INSUFFICIENT_DATA') {
    return { status: 'INSUFFICIENT_DATA', characteristics: {}, conditions: [], learnedAt: new Date().toISOString() };
  }
  if (input.attributionStatus === 'UNKNOWN' || input.outcome === 'UNKNOWN') {
    return { status: 'UNKNOWN', characteristics: {}, conditions: [], learnedAt: new Date().toISOString() };
  }
  if (input.attributionStatus === 'CONFOUNDED') {
    return { status: 'CONFLICTED', characteristics: {}, conditions: ['confounding factors present'], learnedAt: new Date().toISOString() };
  }
  if (input.confidence === 'LOW' || input.confidence === 'UNKNOWN') {
    return { status: 'UNKNOWN', characteristics: {}, conditions: ['insufficient confidence'], learnedAt: new Date().toISOString() };
  }

  const characteristics: Record<string, number> = {
    reliability: input.policyCharacteristics.reliability,
    cost: input.policyCharacteristics.cost,
    performance: input.policyCharacteristics.performance,
    risk: input.policyCharacteristics.risk,
  };

  const conditions: string[] = [];
  if (input.outcome === 'VERIFIED_IMPROVEMENT') {
    conditions.push('positive outcome');
  } else if (input.outcome === 'VERIFIED_REGRESSION') {
    conditions.push('negative outcome');
  } else {
    conditions.push('neutral outcome');
  }
  conditions.push(...input.environmentalConstraints);

  return {
    status: 'LEARNED',
    characteristics,
    conditions,
    learnedAt: new Date().toISOString(),
  };
}
