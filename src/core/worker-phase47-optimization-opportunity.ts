import { randomUUID } from 'crypto';
export function processOptimizationOpportunity(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    opportunityType: input.opportunityType || 'generic',
    currentState: input.currentState || null,
    proposedState: input.proposedState || null,
    expectedBenefit: input.expectedBenefit || null,
    expectedSavings: input.expectedSavings || 0,
    reliabilityImpact: input.reliabilityImpact || 'unknown',
    securityImpact: input.securityImpact || 'unknown',
    blastRadius: input.blastRadius || 'unknown',
    confidence: input.confidence || 0,
    evidence: input.evidence || [],
    governanceRequirement: input.governanceRequirement || null,
  };
}
