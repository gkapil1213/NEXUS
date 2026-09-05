export type HorizonDecisionStatus = 'PROCEED' | 'HOLD' | 'STOP' | 'ROLLBACK' | 'PROMOTE' | 'REVALIDATE';

export interface LongHorizonDecisionInput {
  shortTermImpact: number;
  mediumTermImpact: number;
  longTermImpact: number;
  durability: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  resourceCost: number;
  rollbackCost: number;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  resourceBudgetExceeded: boolean;
  staleTelemetry: boolean;
}

export function makeLongHorizonDecision(input: LongHorizonDecisionInput): HorizonDecisionStatus {
  if (!input.governanceAllowed || !input.safetyAllowed) return 'STOP';
  if (input.staleTelemetry || input.confidence === 'UNKNOWN' || input.risk === 'CRITICAL' || input.risk === 'UNKNOWN') return 'HOLD';
  if (input.resourceBudgetExceeded) return 'STOP';
  if (input.longTermImpact > 0 && input.durability === 'DURABLE_IMPROVEMENT' && input.risk === 'LOW') {
    return 'PROMOTE';
  }
  if (input.longTermImpact < 0 || input.durability === 'REGRESSION') return 'ROLLBACK';
  if (input.confidence === 'LOW') return 'HOLD';
  if (input.shortTermImpact > 0 && input.mediumTermImpact > 0 && input.longTermImpact > 0) {
    return 'PROCEED';
  }
  return 'HOLD';
}
