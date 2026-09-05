export interface DiversificationInput {
  strategyIds: string[];
  fingerprintSimilarity: number; // 0-1
  concentrationScore: number; // 0-1
  strategicIndependence: number; // 0-1
}

export function evaluateDiversification(input: DiversificationInput): { preserved: boolean; reason: string } {
  if (input.fingerprintSimilarity > 0.8) return { preserved: false, reason: 'high similarity' };
  if (input.concentrationScore > 0.7) return { preserved: false, reason: 'high concentration' };
  if (input.strategicIndependence < 0.4) return { preserved: false, reason: 'low independence' };
  return { preserved: true, reason: 'OK' };
}
