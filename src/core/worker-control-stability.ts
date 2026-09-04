export class WorkerControlStability {
  private history: string[] = [];

  record(actionType: string): string {
    this.history.push(actionType);
    if (this.history.length > 6) this.history.shift();
    return this.detectOscillation() ? "OSCILLATING" : "STABLE";
  }

  private detectOscillation(): boolean {
    const h = this.history;
    if (h.length < 4) return false;
    const last4 = h.slice(-4);
    return (
      last4[0] === "SCALE_OUT" && last4[1] === "SCALE_IN" &&
      last4[2] === "SCALE_OUT" && last4[3] === "SCALE_IN"
    );
  }

  reset(): void {
    this.history = [];
  }
}
