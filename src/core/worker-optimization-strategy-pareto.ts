export interface ParetoCandidate {
  id: string;
  metrics: Record<string, number>; // higher is better
  eligible: boolean;
}

export function findParetoOptimal(candidates: ParetoCandidate[]): ParetoCandidate[] {
  const eligible = candidates.filter(c => c.eligible);
  const nonDominated: ParetoCandidate[] = [];
  for (const cand of eligible) {
    let dominated = false;
    for (const other of eligible) {
      if (other.id === cand.id) continue;
      let betterOrEqual = true;
      let strictlyBetter = false;
      for (const key of Object.keys(cand.metrics)) {
        if (other.metrics[key] === undefined || other.metrics[key] < cand.metrics[key]) {
          betterOrEqual = false;
          break;
        }
        if (other.metrics[key] > cand.metrics[key]) strictlyBetter = true;
      }
      if (betterOrEqual && strictlyBetter) {
        dominated = true;
        break;
      }
    }
    if (!dominated) nonDominated.push(cand);
  }
  return nonDominated;
}
