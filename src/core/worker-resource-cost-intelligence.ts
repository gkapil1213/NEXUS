export type CostSource = "observed" | "provider_reported" | "metered" | "estimated" | "unknown";

export interface ResourceCostObservation {
  resourceId: string;
  cost: number;
  source: CostSource;
  confidence: number;
  windowStart: number;
  windowEnd: number;
}

export class WorkerResourceCostIntelligence {
  normalize(obs: ResourceCostObservation): { normalizedCost: number; confidence: number; source: CostSource; valid: boolean } {
    if (!Number.isFinite(obs.cost) || obs.cost < 0 || !Number.isFinite(obs.confidence)) {
      return { normalizedCost: 0, confidence: 0, source: obs.source, valid: false };
    }
    const sourceConfidence = obs.source === "observed" || obs.source === "provider_reported" ? 1 : obs.source === "metered" ? 0.8 : obs.source === "estimated" ? 0.5 : 0.2;
    return {
      normalizedCost: obs.cost,
      confidence: Math.min(obs.confidence * sourceConfidence, 1),
      source: obs.source,
      valid: true,
    };
  }
}
