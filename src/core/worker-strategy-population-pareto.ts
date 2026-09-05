export interface ParetoMember {
  strategyId: string;
  metrics: Record<string, number>;
}

export function computeParetoFrontier(members: ParetoMember[], dimensions: string[]): ParetoMember[] {
  const frontier: ParetoMember[] = [];
  for (const member of members) {
    let dominated = false;
    for (const other of members) {
      if (other.strategyId === member.strategyId) continue;
      let betterOrEqual = true;
      let strictlyBetter = false;
      for (const dim of dimensions) {
        const a = other.metrics[dim] ?? 0;
        const b = member.metrics[dim] ?? 0;
        if (a < b) { betterOrEqual = false; break; }
        if (a > b) strictlyBetter = true;
      }
      if (betterOrEqual && strictlyBetter) { dominated = true; break; }
    }
    if (!dominated) frontier.push(member);
  }
  return frontier;
}
