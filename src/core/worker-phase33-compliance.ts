export type ComplianceStatus = 'COMPLIANT' | 'NON_COMPLIANT' | 'UNKNOWN';

export interface ComplianceFinding {
  findingId: string;
  resourceId: string;
  controlId: string;
  status: ComplianceStatus;
  severity: string;
  reason: string;
}

export function createComplianceFinding(input: Omit<ComplianceFinding, 'findingId'>): ComplianceFinding {
  return { findingId: `cf-${Date.now()}`, ...input };
}
