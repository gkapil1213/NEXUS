export interface DataLearningRecord {
  operationType: string;
  success: boolean;
  duration: number;
  createdAt: string;
}

export function createDataLearningRecord(input: Omit<DataLearningRecord, 'createdAt'>): DataLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
