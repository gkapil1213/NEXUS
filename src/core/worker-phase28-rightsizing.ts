export interface RightsizingRecommendation {
  resourceId: string;
  currentConfiguration: string;
  observedUtilization: number;
  recommendedConfiguration: string;
  expectedCapacityEffect: string;
  expectedCostEffect: string;
  confidence: number;
  rollbackStrategy: string;
  blastRadius: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function createRightsizingRecommendation(input: RightsizingRecommendation): RightsizingRecommendation {
  return input;
}
