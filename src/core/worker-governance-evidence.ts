export interface GovernanceEvidence {
  evidenceId: string;
  requestFingerprint: string;
  policyFingerprint: string;
  policyVersion: number;
  riskDecision: string;
  approvalState: string;
  decision: string;
  reason: string;
  emergency: boolean;
  timestamp: string;
}

export function createGovernanceEvidence(
  input: Omit<GovernanceEvidence, 'evidenceId' | 'timestamp'>
): GovernanceEvidence {
  return { evidenceId: `evidence-${Date.now()}`, ...input, timestamp: new Date().toISOString() };
}
