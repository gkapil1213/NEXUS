export class WorkerChangeRegression {
  detect(beforeMetric: number, afterMetric: number, direction: "increase" | "decrease", threshold: number): "NO_REGRESSION" | "MINOR_REGRESSION" | "MAJOR_REGRESSION" | "UNCERTAIN" {
    if (!Number.isFinite(beforeMetric) || !Number.isFinite(afterMetric)) return "UNCERTAIN";
    const delta = afterMetric - beforeMetric;
    const bad = direction === "decrease" ? delta < 0 : delta > 0;
    if (!bad) return "NO_REGRESSION";
    if (Math.abs(delta) >= threshold * 2) return "MAJOR_REGRESSION";
    if (Math.abs(delta) > threshold) return "MINOR_REGRESSION";
    return "NO_REGRESSION";
  }
}
