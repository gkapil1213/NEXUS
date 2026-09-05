export interface FleetLearningRecord {
  operationType: string;
  success: boolean;
  duration: number;
  createdAt: string;
}

export function createFleetLearningRecord(input: Omit<FleetLearningRecord, 'createdAt'>): FleetLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
