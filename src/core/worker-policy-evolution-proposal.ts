import { randomUUID } from 'crypto';

export type ProposalStatus = 'PROPOSED' | 'DUPLICATE' | 'LOW_CONFIDENCE' | 'HIGH_RISK' | 'MISSING_ROLLBACK' | 'STALE';

export interface PolicyEvolutionProposalInput {
  tenantId: string;
  policyId: string;
  sourceVersion: string;
  proposedVersion: string;
  rationale: string;
  evidenceIds: string[];
  expectedImprovement: string;
  expectedRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  expectedCostImpact: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  expectedReliabilityImpact: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  rollbackPlan: string;
  rolloutPlan: string;
  expiry: string;
  idempotencyKey?: string;
  activeIncident: boolean;
  productionFreeze: boolean;
  cooldownSatisfied: boolean;
  blastRadiusAcceptable: boolean;
  policyCurrent: boolean;
  duplicateCheck: boolean;
}

export interface PolicyEvolutionProposal {
  proposalId: string;
  tenantId: string;
  policyId: string;
  sourceVersion: string;
  proposedVersion: string;
  rationale: string;
  evidenceIds: string[];
  expectedImprovement: string;
  expectedRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  expectedCostImpact: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  expectedReliabilityImpact: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  rollbackPlan: string;
  rolloutPlan: string;
  expiry: string;
  idempotencyKey: string;
  status: ProposalStatus;
  createdAt: string;
}

export function generatePolicyEvolutionProposal(input: PolicyEvolutionProposalInput): PolicyEvolutionProposal | null {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.policyId}:${input.sourceVersion}:${input.proposedVersion}`;

  if (input.activeIncident || input.productionFreeze) return null;
  if (!input.cooldownSatisfied) return null;
  if (!input.blastRadiusAcceptable) return null;
  if (!input.policyCurrent) return null;
  if (input.duplicateCheck) return null;
  if (input.confidence === 'LOW' || input.confidence === 'UNKNOWN') return null;
  if (input.expectedRisk === 'CRITICAL' || input.expectedRisk === 'UNKNOWN') return null;
  if (!input.rollbackPlan || input.rollbackPlan.trim() === '') return null;

  return {
    proposalId: randomUUID(),
    tenantId: input.tenantId,
    policyId: input.policyId,
    sourceVersion: input.sourceVersion,
    proposedVersion: input.proposedVersion,
    rationale: input.rationale,
    evidenceIds: input.evidenceIds,
    expectedImprovement: input.expectedImprovement,
    expectedRisk: input.expectedRisk,
    expectedCostImpact: input.expectedCostImpact,
    expectedReliabilityImpact: input.expectedReliabilityImpact,
    confidence: input.confidence,
    rollbackPlan: input.rollbackPlan,
    rolloutPlan: input.rolloutPlan,
    expiry: input.expiry,
    idempotencyKey,
    status: 'PROPOSED',
    createdAt: new Date().toISOString(),
  };
}
