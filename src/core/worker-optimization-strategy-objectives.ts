export interface ObjectiveConfig {
  objectiveId: string;
  direction: 'MAXIMIZE' | 'MINIMIZE';
  target: number;
  weight: number;
  priority: number; // lower = higher priority
  hard: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  source: string;
  timestamp: string;
}

export function createObjective(input: Omit<ObjectiveConfig, 'timestamp'> & { timestamp?: string }): ObjectiveConfig {
  return {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}
