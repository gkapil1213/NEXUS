export type GenerationSelectionStrategy = 'NEWEST' | 'PROVEN' | 'STABLE' | 'SPECIALIST_PRESERVE' | 'LINEAGE_DIVERSITY';

export interface GenerationSelectionInput {
  generations: {
    generationId: string;
    generationNumber: number;
    successRate: number;
    stabilityScore: number;
    specialist: boolean;
    lineageId: string;
    regressionRate: number;
  }[];
  preferredStrategy?: GenerationSelectionStrategy;
}

export function selectGeneration(input: GenerationSelectionInput): string | null {
  if (input.generations.length === 0) return null;
  const preferred = input.preferredStrategy ?? 'PROVEN';
  if (preferred === 'SPECIALIST_PRESERVE') {
    const specialist = input.generations.filter(g => g.specialist && g.regressionRate < 0.1);
    if (specialist.length > 0) return specialist[0].generationId;
  }
  if (preferred === 'LINEAGE_DIVERSITY') {
    const lineages = new Set(input.generations.map(g => g.lineageId));
    // prefer a generation from a less represented lineage
    const counts = new Map<string, number>();
    for (const g of input.generations) counts.set(g.lineageId, (counts.get(g.lineageId) ?? 0) + 1);
    const sorted = [...input.generations].sort((a, b) => (counts.get(a.lineageId) ?? 0) - (counts.get(b.lineageId) ?? 0));
    return sorted[0].generationId;
  }
  const sorted = [...input.generations].sort((a, b) => {
    if (preferred === 'NEWEST') return b.generationNumber - a.generationNumber;
    if (preferred === 'STABLE') return b.stabilityScore - a.stabilityScore || b.successRate - a.successRate;
    // PROVEN
    return b.successRate - a.successRate || b.stabilityScore - a.stabilityScore;
  });
  return sorted[0].generationId;
}
