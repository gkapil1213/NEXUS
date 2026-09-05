export interface SLO {
  sloId: string;
  metric: string;
  target: number;
  window: string;
  currentValue: number;
  compliance: 'SLO_MET' | 'SLO_AT_RISK' | 'SLO_BREACHED' | 'UNKNOWN';
  burnRate: number;
  updatedAt: string;
}

export function evaluateSLO(currentValue: number, target: number, burnRate: number): 'SLO_MET' | 'SLO_AT_RISK' | 'SLO_BREACHED' | 'UNKNOWN' {
  if (currentValue === undefined || target === undefined) return 'UNKNOWN';
  if (currentValue <= target) return 'SLO_MET';
  if (currentValue <= target * 1.2) return 'SLO_AT_RISK';
  return 'SLO_BREACHED';
}
