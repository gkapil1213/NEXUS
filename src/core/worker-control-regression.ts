export class WorkerControlRegression {
  detect(beforeValue: number, afterValue: number, threshold: number, metricType: "increase" | "decrease" = "decrease"): { regression: boolean; severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" } {
    if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue) || !Number.isFinite(threshold)) return { regression: false, severity: "NONE" };
    const delta = afterValue - beforeValue;
    const regression = metricType === "decrease" ? delta < -threshold : delta > threshold;
    if (!regression) return { regression: false, severity: "NONE" };
    const ratio = Math.abs(delta / threshold);
    if (ratio > 3) return { regression: true, severity: "CRITICAL" };
    if (ratio > 2) return { regression: true, severity: "HIGH" };
    if (ratio > 1) return { regression: true, severity: "MEDIUM" };
    return { regression: true, severity: "LOW" };
  }
}
