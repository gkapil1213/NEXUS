export type OptimizationStabilityState = "STABLE" | "COOLDOWN" | "OSCILLATION" | "THRASHING";

export class WorkerOptimizationStability {
  private history: string[] = [];

  record(action: string): OptimizationStabilityState {
    this.history.push(action);
    if (this.history.length > 6) this.history.shift();
    return this.detect();
  }

  private detect(): OptimizationStabilityState {
    const h = this.history;
    if (h.length < 4) return "STABLE";
    const last4 = h.slice(-4);
    if (last4[0] === "scale_down" && last4[1] === "scale_up" && last4[2] === "scale_down" && last4[3] === "scale_up") return "OSCILLATION";
    const allSame = h.every((a) => a === "scale_down") || h.every((a) => a === "scale_up");
    if (allSame && h.length >= 5) return "THRASHING";
    return "STABLE";
  }

  reset(): void { this.history = []; }
}
