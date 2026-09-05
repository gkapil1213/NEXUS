export interface HistoricalEvidence {
  tenantId: string;
  objective: string;
  scope: string;
  environment: string;
  policyVersion: string;
  workerFleetId?: string;
  infrastructureType?: string;
  workloadType?: string;
  resourceConstraints?: Record<string, number>;
  successCount: number;
  failureCount: number;
  regressionCount: number;
  similarExperiments: string[];
  knownInteractions: string[];
  durabilityEvidence: string[];
  riskHistory: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
}

export function retrieveHistoricalEvidence(
  input: Omit<HistoricalEvidence, 'successCount' | 'failureCount' | 'regressionCount' | 'similarExperiments' | 'knownInteractions' | 'durabilityEvidence' | 'riskHistory' | 'confidence'>,
  memory: HistoricalEvidence[]
): HistoricalEvidence | null {
  const matches = memory.filter(m => 
    m.tenantId === input.tenantId &&
    m.objective === input.objective &&
    m.scope === input.scope &&
    m.environment === input.environment &&
    (input.policyVersion === undefined || m.policyVersion === input.policyVersion)
  );
  if (matches.length === 0) return null;

  // Aggregate evidence
  const successCount = matches.reduce((s, m) => s + m.successCount, 0);
  const failureCount = matches.reduce((s, m) => s + m.failureCount, 0);
  const regressionCount = matches.reduce((s, m) => s + m.regressionCount, 0);
  const confidence = successCount > failureCount ? 'MEDIUM' : 'LOW';

  return {
    ...input,
    successCount,
    failureCount,
    regressionCount,
    similarExperiments: [...new Set(matches.flatMap(m => m.similarExperiments))],
    knownInteractions: [...new Set(matches.flatMap(m => m.knownInteractions))],
    durabilityEvidence: [...new Set(matches.flatMap(m => m.durabilityEvidence))],
    riskHistory: [...new Set(matches.flatMap(m => m.riskHistory))],
    confidence,
  };
}
