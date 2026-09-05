export type StrategyInteractionType = 'POSITIVE' | 'NEUTRAL' | 'ANTAGONISTIC' | 'UNKNOWN';

export interface StrategyInteractionInput {
  strategies: string[];
  combinedDelta: Record<string, number>;
  individualDeltas: Record<string, number>;
  evidenceQuality: number; // 0-1
  temporalValidity: boolean;
}

export function classifyStrategyInteraction(input: StrategyInteractionInput): StrategyInteractionType {
  if (!input.temporalValidity || input.evidenceQuality < 0.5) return 'UNKNOWN';
  const individualSum = Object.values(input.individualDeltas).reduce((s, v) => s + v, 0);
  const combined = Object.values(input.combinedDelta).reduce((s, v) => s + v, 0);
  const diff = combined - individualSum;
  if (diff > 0.01) return 'POSITIVE';
  if (diff < -0.01) return 'ANTAGONISTIC';
  return 'NEUTRAL';
}
