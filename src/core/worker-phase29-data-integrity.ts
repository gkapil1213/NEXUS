export interface DataIntegrityFinding {
  findingId: string;
  resourceId: string;
  detectionType: string;
  severity: string;
  evidence: string[];
  impact: string;
  recommendedAction: string;
}

export function createDataIntegrityFinding(input: DataIntegrityFinding): DataIntegrityFinding {
  return input;
}
