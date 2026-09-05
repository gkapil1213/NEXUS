export type DominanceRelation = 'DOMINATED' | 'NON_DOMINATED' | 'STRONGLY_DOMINATED' | 'WEAKLY_DOMINATED' | 'INCOMPARABLE';

export interface DominanceInput {
  candidate: Record<string, number>;
  others: Record<string, number>[];
  dimensions: string[];
}

export function evaluateDominance(input: DominanceInput): DominanceRelation {
  let weaklyDominated = false;

  for (const other of input.others) {
    let betterOrEqual = true;
    let strictlyBetter = false;

    for (const dim of input.dimensions) {
      const otherValue = other[dim] ?? 0;
      const candidateValue = input.candidate[dim] ?? 0;
      if (otherValue < candidateValue) {
        betterOrEqual = false;
        break;
      }
      if (otherValue > candidateValue) {
        strictlyBetter = true;
      }
    }

    if (betterOrEqual && strictlyBetter) {
      return 'DOMINATED';
    }
    if (betterOrEqual && !strictlyBetter) {
      weaklyDominated = true;
    }
  }

  if (weaklyDominated) return 'WEAKLY_DOMINATED';
  return 'NON_DOMINATED';
}
