export type DiversityStatus = 'HEALTHY_DIVERSITY' | 'LOW_DIVERSITY' | 'EXCESSIVE_DUPLICATION' | 'CONVERGENCE_RISK';

export interface DiversityInput {
  fingerprints: string[];
  objectiveProfiles: Record<string, number>[];
  lineageDistances: number[];
  resourceProfiles: Record<string, number>[];
  executionCharacteristics: Record<string, number>[];
  failurePatterns: string[][];
}

export function evaluateDiversity(input: DiversityInput): DiversityStatus {
  if (input.fingerprints.length === 0) return 'LOW_DIVERSITY';
  const uniqueFingerprints = new Set(input.fingerprints);
  const uniqueRatio = uniqueFingerprints.size / input.fingerprints.length;
  if (uniqueRatio < 0.3) return 'EXCESSIVE_DUPLICATION';
  if (uniqueRatio < 0.6) return 'LOW_DIVERSITY';
  // Check objective profile similarity
  const profileSimilarity = averageProfileSimilarity(input.objectiveProfiles);
  if (profileSimilarity > 0.8) return 'CONVERGENCE_RISK';
  return 'HEALTHY_DIVERSITY';
}

function averageProfileSimilarity(profiles: Record<string, number>[]): number {
  if (profiles.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      total += cosineSimilarity(profiles[i], profiles[j]);
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}

function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, normA = 0, normB = 0;
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
