export interface LearningRecord {
  incidentType: string;
  remediationType: string;
  predictedRisk: string;
  actualRisk: string;
  predictedOutcome: string;
  actualOutcome: string;
  verification: string;
  rollback: string;
  duration: number;
  recurrence: number;
  createdAt: string;
}

export function createLearningRecord(input: Omit<LearningRecord, 'createdAt'>): LearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
