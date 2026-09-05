export interface EvolutionPressure {
  explorationPressure: number; // 0-1
  exploitationPressure: number; // 0-1
  mutationPressure: number; // 0-1
  preservationPressure: number; // 0-1
  retirementPressure: number; // 0-1
}

export function calculateEvolutionPressure(input: {
  populationSize: number;
  championCount: number;
  challengerCount: number;
  retiredCount: number;
  stagnationScore: number;
  diversityScore: number;
  regressionRate: number;
}): EvolutionPressure {
  const total = Math.max(1, input.populationSize);
  const exploration = (input.challengerCount / total) * (1 - input.stagnationScore) + (1 - input.diversityScore) * 0.3;
  const exploitation = (input.championCount / total) * (1 - input.regressionRate) + input.diversityScore * 0.3;
  const mutation = Math.max(0, 0.2 + input.stagnationScore * 0.5 - input.diversityScore * 0.3);
  const preservation = 1 - input.regressionRate - input.retiredCount / total;
  const retirement = input.retiredCount / total + input.regressionRate * 0.5;
  return {
    explorationPressure: clamp(exploration),
    exploitationPressure: clamp(exploitation),
    mutationPressure: clamp(mutation),
    preservationPressure: clamp(preservation),
    retirementPressure: clamp(retirement),
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
