export type StabilityState = "NORMAL" | "COOLDOWN" | "OSCILLATION" | "THRASHING";

export class WorkerScalingStability {
  private history: string[] = [];

  record(action: string): StabilityState {
    this.history.push(action);
    if (this.history.length > 6) this.history.shift();
    return this.detect();
  }

  private detect(): StabilityState {
    const h = this.history;
    if (h.length < 4) return "NORMAL";
    const last4 = h.slice(-4);
    const oscillation = last4[0] === "SCALE_UP" && last4[1] === "SCALE_DOWN" && last4[2] === "SCALE_UP" && last4[3] === "SCALE_DOWN";
    if (oscillation) return "OSCILLATION";
    const allSame = h.every((a) => a === "SCALE_UP") || h.every((a) => a === "SCALE_DOWN");
    if (allSame && h.length >= 5) return "THRASHING";
    return "NORMAL";
  }

  reset(): void { this.history = []; }
}
