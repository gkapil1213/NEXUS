export interface FleetChangeCorrelation {
  correlationId: string;
  fleetId: string;
  changeId: string;
  type: 'BEFORE' | 'DURING' | 'AFTER';
  confidence: number;
}

export function correlateFleetChange(fleetId: string, changeId: string, changeTime: string, incidentTime: string): FleetChangeCorrelation {
  const chg = new Date(changeTime).getTime();
  const inc = new Date(incidentTime).getTime();
  const type = chg <= inc ? 'BEFORE' : 'AFTER';
  return { correlationId: `corr-${fleetId}-${Date.now()}`, fleetId, changeId, type, confidence: type === 'BEFORE' ? 0.7 : 0.3 };
}
