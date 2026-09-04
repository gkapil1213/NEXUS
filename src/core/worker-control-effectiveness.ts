export type EffectivenessClassification = "HELPFUL" | "NEUTRAL" | "INEFFECTIVE" | "HARMFUL" | "UNKNOWN";

export class WorkerControlEffectiveness {
  classify(beforeSli: number, afterSli: number, expectedDirection: "increase" | "decrease", confidence: number): EffectivenessClassification {
    if (!Number.isFinite(beforeSli) || !Number.isFinite(afterSli) || !Number.isFinite(confidence)) return "UNKNOWN";
    if (confidence < 0.5) return "UNKNOWN";
    const delta = afterSli - beforeSli;
    const good = expectedDirection === "increase" ? delta > 0 : delta < 0;
    if (good) return "HELPFUL";
    if (delta === 0) return "NEUTRAL";
    return delta !== 0 ? (Math.abs(delta) < 0.01 ? "INEFFECTIVE" : "HARMFUL") : "NEUTRAL";
  }
}
