import { randomUUID } from 'crypto';
export function processScalingOpportunity(input: any): any {
  return { id: randomUUID(), resourceId: input.resourceId, opportunityType: input.opportunityType || 'generic', reason: input.reason || null, evidence: input.evidence || [], expectedImpact: input.expectedImpact || null, risk: input.risk || null, constraints: input.constraints || null, proposedAction: input.proposedAction || null, confidence: input.confidence || 0 };
}
