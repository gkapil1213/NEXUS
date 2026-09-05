export interface PostmortemRecord {
  postmortemId: string;
  incidentId: string;
  timeline: string[];
  detection: string;
  impact: string;
  rootCauseCandidates: string[];
  remediation: string;
  verification: string;
  contributingFactors: string[];
  evidence: string[];
  lessonsLearned: string[];
  createdAt: string;
}

export function createPostmortem(input: Omit<PostmortemRecord, 'postmortemId' | 'createdAt'>): PostmortemRecord {
  return { postmortemId: `pm-${input.incidentId}-${Date.now()}`, ...input, createdAt: new Date().toISOString() };
}
