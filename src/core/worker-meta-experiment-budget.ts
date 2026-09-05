export interface MetaBudget {
  maxExperiments: number;
  maxConcurrent: number;
  maxCandidateEvaluations: number;
  maxCompute: number;
  maxDuration: number;
}

export function checkMetaBudget(budget: MetaBudget, currentUsage: { experiments: number; concurrent: number; evaluations: number; compute: number; duration: number }): { allowed: boolean; reason: string } {
  if (currentUsage.experiments >= budget.maxExperiments) return { allowed: false, reason: 'experiments budget exceeded' };
  if (currentUsage.concurrent >= budget.maxConcurrent) return { allowed: false, reason: 'concurrency budget exceeded' };
  if (currentUsage.evaluations >= budget.maxCandidateEvaluations) return { allowed: false, reason: 'evaluation budget exceeded' };
  if (currentUsage.compute >= budget.maxCompute) return { allowed: false, reason: 'compute budget exceeded' };
  if (currentUsage.duration >= budget.maxDuration) return { allowed: false, reason: 'duration budget exceeded' };
  return { allowed: true, reason: 'OK' };
}
