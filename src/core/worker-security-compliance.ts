export type ControlStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT_ASSESSED' | 'UNAVAILABLE';

export interface ComplianceControl {
  controlId: string;
  framework: string;
  description: string;
  status: ControlStatus;
  evidenceRefs: string[];
}

export interface ComplianceAssessment {
  assessmentId: string;
  framework: string;
  controls: ComplianceControl[];
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createComplianceAssessment(
  framework: string,
  controls: ComplianceControl[],
  correlationId: string,
  idempotencyKey?: string
): ComplianceAssessment {
  return {
    assessmentId: `assessment-${framework}-${Date.now()}`,
    framework,
    controls,
    createdAt: new Date().toISOString(),
    correlationId,
    idempotencyKey: idempotencyKey ?? `${framework}:${correlationId}`,
  };
}
