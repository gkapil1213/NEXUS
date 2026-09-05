export interface RuntimeLearningRecord {
  condition: string;
  remediation: string;
  success: boolean;
  duration: number;
  createdAt: string;
}

export function createRuntimeLearningRecord(input: Omit<RuntimeLearningRecord, 'createdAt'>): RuntimeLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
