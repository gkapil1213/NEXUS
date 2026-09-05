export interface HaltRecord {
  haltId: string;
  executionId: string;
  reason: string;
  timestamp: string;
}

export function createDeploymentHalt(executionId: string, reason: string): HaltRecord {
  return { haltId: `halt-${executionId}-${Date.now()}`, executionId, reason, timestamp: new Date().toISOString() };
}
