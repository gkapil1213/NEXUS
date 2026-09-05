export interface CorrelationInput {
  sharedDependencies: string[];
  sharedTargets: string[];
  sharedInfrastructure: string[];
}

export function detectCorrelation(input: CorrelationInput): number {
  const total = new Set([...input.sharedDependencies, ...input.sharedTargets, ...input.sharedInfrastructure]).size;
  return Math.min(1, total / 10);
}
