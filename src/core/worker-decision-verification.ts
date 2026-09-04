export class WorkerDecisionVerification {
  verify(reliability: number, sloState: string, telemetryFresh: boolean): "SUCCESS" | "PARTIAL" | "FAILED" | "REGRESSED" | "UNKNOWN" {
    if (!telemetryFresh) return "UNKNOWN";
    if (reliability < 0.5 || sloState === "CRITICAL") return "REGRESSED";
    if (sloState === "BREACHING") return "FAILED";
    if (reliability > 0.8 && sloState === "HEALTHY") return "SUCCESS";
    return "PARTIAL";
  }
}
