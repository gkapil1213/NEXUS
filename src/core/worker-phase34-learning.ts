export interface LearningRecord {
  identityId: string;
  outcome: string;
  success: boolean;
  createdAt: string;
}

export function createLearningRecord(input: Omit<LearningRecord, 'createdAt'>): LearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
