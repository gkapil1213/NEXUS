export interface SecurityLearningRecord {
  incidentType: string;
  remediationType: string;
  success: boolean;
  duration: number;
  recurrence: number;
  createdAt: string;
}

export function createSecurityLearningRecord(input: Omit<SecurityLearningRecord, 'createdAt'>): SecurityLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
