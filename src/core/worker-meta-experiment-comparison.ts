export type ComparisonResult = 'WINNER' | 'HOLD' | 'INSUFFICIENT_EVIDENCE' | 'CONFLICTING';

export interface MethodMetrics {
  methodId: string;
  improvement: number;
  confidence: number;
  cost: number;
  regression: number;
  rollback: number;
  diversityImpact: number;
}

export function compareMethods(metrics: MethodMetrics[], confidenceThreshold: number): { winner?: string; decision: ComparisonResult } {
  const eligible = metrics.filter(m => m.confidence >= confidenceThreshold);
  if (eligible.length === 0) return { decision: 'INSUFFICIENT_EVIDENCE' };
  const sorted = [...eligible].sort((a, b) => b.improvement - a.improvement);
  const top = sorted[0];
  const second = sorted[1];
  if (!second) return { winner: top.methodId, decision: 'HOLD' }; // only one eligible
  if (top.improvement - second.improvement > 0.01 && top.regression <= second.regression) {
    return { winner: top.methodId, decision: 'WINNER' };
  }
  return { decision: 'HOLD' };
}
