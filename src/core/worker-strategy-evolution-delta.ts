export interface StrategyDelta {
  parentGenerationId: string;
  candidateId: string;
  changedFields: string[];
  addedConstraints: string[];
  removedConstraints: string[];
  objectiveChanges: Record<string, number>;
  riskChanges: Record<string, number>;
  resourceChanges: Record<string, number>;
  expectedPerformanceChanges: Record<string, number>;
}

export function computeStrategyDelta(
  parent: Record<string, unknown>,
  candidate: Record<string, unknown>,
  parentConstraints: string[],
  candidateConstraints: string[]
): StrategyDelta {
  const changedFields = Object.keys(candidate).filter(key => parent[key] !== candidate[key]);
  const added = candidateConstraints.filter(c => !parentConstraints.includes(c));
  const removed = parentConstraints.filter(c => !candidateConstraints.includes(c));
  return {
    parentGenerationId: parent.generationId as string,
    candidateId: candidate.candidateId as string,
    changedFields,
    addedConstraints: added,
    removedConstraints: removed,
    objectiveChanges: {},
    riskChanges: {},
    resourceChanges: {},
    expectedPerformanceChanges: {},
  };
}
