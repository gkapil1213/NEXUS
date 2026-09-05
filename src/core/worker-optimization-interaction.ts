export type InteractionResult = 'POSITIVE_SYNERGY' | 'NEUTRAL' | 'NEGATIVE_INTERACTION' | 'UNSAFE' | 'UNKNOWN';

export interface InteractionInput {
  candidateA: string;
  candidateB: string;
  sharedMetrics: Record<string, number>; // expected combined impact deltas
  hardConstraintViolation: boolean;
  conflict: boolean;
  dependencyConflict: boolean;
  rolloutCollision: boolean;
}

export function detectInteraction(input: InteractionInput): InteractionResult {
  if (input.hardConstraintViolation || input.rolloutCollision || input.dependencyConflict) {
    return 'UNSAFE';
  }
  if (input.conflict) {
    return 'NEGATIVE_INTERACTION';
  }
  const values = Object.values(input.sharedMetrics);
  if (values.every(v => v > 0)) {
    return 'POSITIVE_SYNERGY';
  }
  if (values.every(v => v === 0)) {
    return 'NEUTRAL';
  }
  if (values.some(v => v < 0)) {
    return 'NEGATIVE_INTERACTION';
  }
  return 'UNKNOWN';
}
