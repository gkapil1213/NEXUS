export type RedundancyClassification = 'UNIQUE' | 'COMPLEMENTARY' | 'PARTIALLY_REDUNDANT' | 'HIGHLY_REDUNDANT' | 'DUPLICATE';

export interface RedundancyInput {
  fingerprintA: string;
  fingerprintB: string;
  objectiveSimilarity: number; // 0-1
  behavioralSimilarity: number; // 0-1
  resourceProfileSimilarity: number; // 0-1
  failurePatternOverlap: number; // 0-1
}

export function classifyRedundancy(input: RedundancyInput): RedundancyClassification {
  if (input.fingerprintA === input.fingerprintB) return 'DUPLICATE';
  const score = (input.objectiveSimilarity + input.behavioralSimilarity + input.resourceProfileSimilarity + input.failurePatternOverlap) / 4;
  if (score >= 0.8) return 'HIGHLY_REDUNDANT';
  if (score >= 0.6) return 'PARTIALLY_REDUNDANT';
  if (score >= 0.4) return 'COMPLEMENTARY';
  return 'UNIQUE';
}
