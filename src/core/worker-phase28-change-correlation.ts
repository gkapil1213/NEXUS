export interface InfrastructureChangeCorrelation {
  correlationId: string;
  resourceId: string;
  changeId: string;
  type: 'BEFORE' | 'DURING' | 'AFTER';
  confidence: number;
}

export function correlateInfrastructureChange(resourceId: string, changeId: string, changeTime: string, incidentTime: string): InfrastructureChangeCorrelation {
  const chg = new Date(changeTime).getTime();
  const inc = new Date(incidentTime).getTime();
  const type = chg <= inc ? 'BEFORE' : 'AFTER';
  return { correlationId: `corr-${resourceId}-${Date.now()}`, resourceId, changeId, type, confidence: type === 'BEFORE' ? 0.7 : 0.3 };
}
