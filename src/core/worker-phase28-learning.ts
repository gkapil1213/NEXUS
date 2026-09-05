export interface InfrastructureLearningRecord {
  opportunityType: string;
  success: boolean;
  duration: number;
  createdAt: string;
}

export function createInfrastructureLearningRecord(input: Omit<InfrastructureLearningRecord, 'createdAt'>): InfrastructureLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
