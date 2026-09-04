export type ScalingOutcome = "EFFECTIVE" | "PARTIALLY_EFFECTIVE" | "INEFFECTIVE" | "REGRESSION" | "UNKNOWN";

export class WorkerScalingOutcome {
  classify(beforeUtilization: number, afterUtilization: number, sloStateBefore: string, sloStateAfter: string, reliabilityBefore: number, reliabilityAfter: number): ScalingOutcome {
    if (!Number.isFinite(beforeUtilization) || !Number.isFinite(afterUtilization) || !Number.isFinite(reliabilityBefore) || !Number.isFinite(reliabilityAfter)) return "UNKNOWN";
    const utilizationDelta = afterUtilization - beforeUtilization;
    const reliabilityDelta = reliabilityAfter - reliabilityBefore;
    if (sloStateAfter === "CRITICAL" || sloStateAfter === "BREACHING") return "REGRESSION";
    if (reliabilityDelta < -0.05 || utilizationDelta > 0.1) return "INEFFECTIVE";
    if (utilizationDelta < 0.05 && reliabilityDelta > 0) return "EFFECTIVE";
    return "PARTIALLY_EFFECTIVE";
  }
}
