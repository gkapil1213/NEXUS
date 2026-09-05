export type InteractionClassification = 'SYNERGISTIC' | 'ANTAGONISTIC' | 'NEUTRAL' | 'UNCONFIRMED';

export interface StrategyInteractionInput {
  strategyA: string;
  strategyB: string;
  combinedDelta: Record<string, number>;
  observedAAlone: Record<string, number>;
  observedBAlone: Record<string, number>;
  temporalOrdering: boolean;
  controlledEvidence: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  telemetryFresh: boolean;
}

export function classifyStrategyInteraction(input: StrategyInteractionInput): InteractionClassification {
  if (!input.telemetryFresh || !input.temporalOrdering || !input.controlledEvidence) {
    return 'UNCONFIRMED';
  }
  if (input.confidence === 'LOW' || input.confidence === 'UNKNOWN') {
    return 'UNCONFIRMED';
  }

  const expectedSum = sumAllValues(input.observedAAlone) + sumAllValues(input.observedBAlone);
  const combined = sumAllValues(input.combinedDelta);

  if (combined > expectedSum + 0.01) {
    return 'SYNERGISTIC';
  }
  if (combined < expectedSum - 0.01) {
    return 'ANTAGONISTIC';
  }
  return 'NEUTRAL';
}

function sumAllValues(obj: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(obj)) {
    total += value;
  }
  return total;
}
