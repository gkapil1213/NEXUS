export interface PolicyEvolutionContext {
  tenantId: string;
  policyId: string;
  parentVersion: string;
  proposedVersion: string;
  decisionId: string;
  learningCycleId: string;
  correlationId: string;
  workerScope: string;
  evidenceReferences: string[];
  baselinePeriod: { start: string; end: string };
  treatmentPeriod: { start: string; end: string };
  controlPeriod?: { start: string; end: string };
  expectedOutcome: string;
  actualOutcome?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  governanceState: 'PENDING' | 'ALLOW' | 'DENY' | 'DEFER';
  safetyState: 'PENDING' | 'ALLOW' | 'DENY' | 'DEFER' | 'OBSERVE_ONLY';
}

export function createPolicyEvolutionContext(input: Partial<PolicyEvolutionContext> & Pick<PolicyEvolutionContext, 'tenantId' | 'policyId' | 'parentVersion' | 'proposedVersion'>): PolicyEvolutionContext {
  return {
    tenantId: input.tenantId,
    policyId: input.policyId,
    parentVersion: input.parentVersion,
    proposedVersion: input.proposedVersion,
    decisionId: input.decisionId ?? '',
    learningCycleId: input.learningCycleId ?? '',
    correlationId: input.correlationId ?? '',
    workerScope: input.workerScope ?? '',
    evidenceReferences: input.evidenceReferences ?? [],
    baselinePeriod: input.baselinePeriod ?? { start: '', end: '' },
    treatmentPeriod: input.treatmentPeriod ?? { start: '', end: '' },
    controlPeriod: input.controlPeriod,
    expectedOutcome: input.expectedOutcome ?? '',
    actualOutcome: input.actualOutcome,
    confidence: input.confidence ?? 'UNKNOWN',
    risk: input.risk ?? 'UNKNOWN',
    governanceState: input.governanceState ?? 'PENDING',
    safetyState: input.safetyState ?? 'PENDING',
  };
}
