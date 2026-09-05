export type RetirementStatus = 'ACTIVE' | 'RETIRED' | 'SUPERSEDED';

export interface RetirementInput {
  generationId: string;
  strategyId: string;
  tenantId: string;
  obsolete: boolean;
  unsafe: boolean;
  superseded: boolean;
  unused: boolean;
  degraded: boolean;
  outsideObjectives: boolean;
  governanceDecision: string;
}

export function decideRetirement(input: RetirementInput): RetirementStatus {
  if (input.governanceDecision !== 'ALLOW') return 'ACTIVE';
  if (input.unsafe || input.superseded || input.obsolete || input.outsideObjectives) return 'RETIRED';
  return 'ACTIVE';
}
