export interface RootCauseCandidate {
  candidateId: string;
  serviceId: string;
  category: string;
  confidence: number;
  evidence: string[];
  explanation: string;
  createdAt: string;
}

export function createRootCauseCandidate(input: Omit<RootCauseCandidate, 'candidateId' | 'createdAt'>): RootCauseCandidate {
  return { candidateId: `rc-${Date.now()}`, ...input, createdAt: new Date().toISOString() };
}
