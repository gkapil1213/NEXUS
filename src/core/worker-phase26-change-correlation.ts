export interface ChangeCorrelation {
  correlationId: string;
  incidentId: string;
  releaseId?: string;
  deploymentId?: string;
  type: 'BEFORE' | 'DURING' | 'AFTER';
  confidence: number;
  evidence: string[];
  createdAt: string;
}

export function correlateChange(incidentId: string, releaseId: string, deploymentId: string, incidentTime: string, changeTime: string): ChangeCorrelation {
  let type: 'BEFORE' | 'DURING' | 'AFTER' = 'AFTER';
  const inc = new Date(incidentTime).getTime();
  const chg = new Date(changeTime).getTime();
  if (chg < inc) type = 'BEFORE';
  else if (chg <= inc + 60000) type = 'DURING';
  else type = 'AFTER';
  return {
    correlationId: `change-${incidentId}-${Date.now()}`,
    incidentId,
    releaseId,
    deploymentId,
    type,
    confidence: type === 'BEFORE' ? 0.7 : 0.3,
    evidence: [],
    createdAt: new Date().toISOString(),
  };
}
