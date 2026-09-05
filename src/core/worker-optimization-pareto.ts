export interface ParetoCandidate {
  id: string;
  metrics: Record<string, number>; // e.g., cost, latency, reliability (higher is better for MAXIMIZE)
  hardConstraintsViolated: boolean;
}

export type ParetoClassification = 'DOMINATED' | 'NON_DOMINATED' | 'INFEASIBLE' | 'UNCERTAIN';

export function classifyPareto(candidate: ParetoCandidate, others: ParetoCandidate[]): ParetoClassification {
  if (candidate.hardConstraintsViolated) return 'INFEASIBLE';
  if (candidate.metrics === undefined || Object.keys(candidate.metrics).length === 0) return 'UNCERTAIN';
  // For simplicity, assume all metrics are to be maximized. If any other candidate dominates this one, return DOMINATED.
  for (const other of others) {
    if (other.id === candidate.id) continue;
    if (other.hardConstraintsViolated) continue;
    let otherBetterOrEqual = true;
    let otherStrictlyBetter = false;
    for (const key of Object.keys(candidate.metrics)) {
      if (other.metrics[key] === undefined) { otherBetterOrEqual = false; break; }
      if (other.metrics[key] < candidate.metrics[key]) { otherBetterOrEqual = false; break; }
      if (other.metrics[key] > candidate.metrics[key]) otherStrictlyBetter = true;
    }
    if (otherBetterOrEqual && otherStrictlyBetter) {
      return 'DOMINATED';
    }
  }
  return 'NON_DOMINATED';
}
