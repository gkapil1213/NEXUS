export class WorkerReliabilityRegression {
  detect(beforeSuccessRate: number, afterSuccessRate: number, threshold: number = 0.2): "NO_REGRESSION" | "POSSIBLE_REGRESSION" | "CONFIRMED_REGRESSION" {
    if (!Number.isFinite(beforeSuccessRate) || !Number.isFinite(afterSuccessRate)) return "NO_REGRESSION";
    const drop = beforeSuccessRate - afterSuccessRate;
    if (drop > threshold * 1.5) return "CONFIRMED_REGRESSION";
    if (drop > threshold) return "POSSIBLE_REGRESSION";
    return "NO_REGRESSION";
  }
}
