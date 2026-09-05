export interface ReallocationInput {
  strategyId: string;
  effectiveness: number;
  confidence: number;
  recentOutcome: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  risk: number;
  resourceCost: number;
  diversityImpact: number;
}

export function proposeReallocation(input: ReallocationInput): 'INCREASE' | 'DECREASE' | 'MAINTAIN' | 'PAUSE' | 'REPLACE' | 'RETIRE' {
  if (input.recentOutcome === 'NEGATIVE' && input.risk > 0.7) return 'RETIRE';
  if (input.effectiveness < 0.2) return 'REPLACE';
  if (input.confidence < 0.3) return 'PAUSE';
  if (input.recentOutcome === 'POSITIVE' && input.effectiveness > 0.7 && input.risk < 0.5) return 'INCREASE';
  if (input.recentOutcome === 'NEGATIVE') return 'DECREASE';
  return 'MAINTAIN';
}
