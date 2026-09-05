export type Objective = 'SAFETY' | 'RELIABILITY' | 'RECOVERY' | 'AVAILABILITY' | 'PERFORMANCE' | 'COST';

export interface ObjectiveImpact {
  objective: Objective;
  impact: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNKNOWN';
}

export interface ArbitrationInput {
  tenantId: string;
  policyId: string;
  impacts: ObjectiveImpact[];
}

export interface ArbitrationResult {
  decision: 'ALLOW' | 'DENY' | 'DEFER';
  reason: string;
  priority: Objective | null;
}

const PRIORITY_ORDER: Objective[] = ['SAFETY', 'RELIABILITY', 'RECOVERY', 'AVAILABILITY', 'PERFORMANCE', 'COST'];

export function arbitrateObjectives(input: ArbitrationInput): ArbitrationResult {
  if (!input.impacts || input.impacts.length === 0) {
    return { decision: 'DEFER', reason: 'no objective impacts provided', priority: null };
  }

  const impactMap = new Map<Objective, ObjectiveImpact['impact'][]>();
  for (const imp of input.impacts) {
    if (!impactMap.has(imp.objective)) {
      impactMap.set(imp.objective, []);
    }
    impactMap.get(imp.objective)!.push(imp.impact);
  }

  for (const obj of PRIORITY_ORDER) {
    if (!impactMap.has(obj)) continue;
    const impacts = impactMap.get(obj)!;
    const hasNegative = impacts.includes('NEGATIVE');
    const hasUnknown = impacts.includes('UNKNOWN');
    const hasPositive = impacts.includes('POSITIVE');

    if (hasNegative) {
      return { decision: 'DENY', reason: `negative impact on ${obj}`, priority: obj };
    }
    if (hasUnknown) {
      return { decision: 'DEFER', reason: `unknown impact on ${obj}`, priority: obj };
    }
  }

  return { decision: 'ALLOW', reason: 'all objectives acceptable', priority: null };
}
