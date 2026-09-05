export type ComplianceStatus = 'COMPLIANT' | 'NON_COMPLIANT' | 'PARTIAL' | 'UNKNOWN' | 'NOT_APPLICABLE';

export interface ComplianceEvaluation {
  controlId: string;
  resourceId: string;
  scope: string;
  status: ComplianceStatus;
  reason: string;
  evidenceRefs: string[];
  evaluatedAt: string;
  policyVersion: number;
}

export function evaluateCompliance(input: Omit<ComplianceEvaluation, 'evaluatedAt'>): ComplianceEvaluation {
  return { ...input, evaluatedAt: new Date().toISOString() };
}
