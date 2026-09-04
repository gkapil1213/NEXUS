export class WorkerSloBurn {
  evaluate(shortBurnRate: number, longBurnRate: number): "NORMAL" | "ELEVATED" | "HIGH" | "CRITICAL" | "INSUFFICIENT_DATA" {
    if (!Number.isFinite(shortBurnRate) || !Number.isFinite(longBurnRate)) return "INSUFFICIENT_DATA";
    const maxRate = Math.max(shortBurnRate, longBurnRate);
    if (maxRate > 5) return "CRITICAL";
    if (maxRate > 3) return "HIGH";
    if (maxRate > 1.5) return "ELEVATED";
    return "NORMAL";
  }
}
