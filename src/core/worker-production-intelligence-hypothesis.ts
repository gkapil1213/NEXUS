import { randomUUID } from 'crypto';

export interface Hypothesis {
  hypothesisId: string;
  category: string;
  confidence: number;
  supportingSignals: string[];
  contradictingSignals: string[];
  explanation: string;
  recommendedAction: string;
  createdAt: string;
}

export function generateHypothesis(input: {
  category: string;
  supportingSignals: string[];
  contradictingSignals?: string[];
  confidence: number;
}): Hypothesis {
  return {
    hypothesisId: randomUUID(),
    category: input.category,
    confidence: input.confidence,
    supportingSignals: input.supportingSignals,
    contradictingSignals: input.contradictingSignals ?? [],
    explanation: `Hypothesis: ${input.category} based on ${input.supportingSignals.length} supporting signals`,
    recommendedAction: 'investigate',
    createdAt: new Date().toISOString(),
  };
}
