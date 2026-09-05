export interface PortfolioCandidateProfile {
  candidateId: string;
  score: number;
  confidence: number;
  risk: number;
  diversityContribution: number;
}

export function selectPortfolioCandidates(profiles: PortfolioCandidateProfile[], maxCandidates: number): string[] {
  if (profiles.length === 0) return [];
  const sorted = [...profiles].sort((a,b) => b.score - a.score);
  return sorted.slice(0, Math.min(maxCandidates, sorted.length)).map(p => p.candidateId);
}
