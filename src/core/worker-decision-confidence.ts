export class WorkerDecisionConfidence {
  evaluate(telemetryFresh: boolean, dataComplete: boolean, agreement: number, historicalEvidence: number): "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" {
    if (!telemetryFresh || !dataComplete) return "LOW";
    if (agreement < 0.5 || historicalEvidence < 0.5) return "LOW";
    if (agreement > 0.8 && historicalEvidence > 0.8) return "HIGH";
    if (agreement > 0.6 && historicalEvidence > 0.6) return "MEDIUM";
    return "LOW";
  }
}
