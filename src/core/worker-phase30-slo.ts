export interface SLO {
  sloId: string;
  serviceId: string;
  metric: string;
  target: number;
  window: string;
  currentValue: number;
  burnRate: number;
  status: 'HEALTHY' | 'WARNING' | 'VIOLATED' | 'UNKNOWN';
  updatedAt: string;
}

export function evaluateSLO(currentValue: number, target: number, burnRate: number): 'HEALTHY' | 'WARNING' | 'VIOLATED' | 'UNKNOWN' {
  if (currentValue === undefined || target === undefined) return 'UNKNOWN';
  if (currentValue <= target) return 'HEALTHY';
  if (currentValue <= target * 1.2) return 'WARNING';
  return 'VIOLATED';
}
