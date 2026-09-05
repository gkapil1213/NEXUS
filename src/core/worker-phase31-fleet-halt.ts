export interface FleetHaltRecord {
  haltId: string;
  executionId: string;
  reason: string;
  timestamp: string;
}

export function createFleetHalt(executionId: string, reason: string): FleetHaltRecord {
  return { haltId: `halt-${executionId}-${Date.now()}`, executionId, reason, timestamp: new Date().toISOString() };
}
