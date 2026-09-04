export class WorkerDecisionRisk {
  evaluate(reliability: number, sloState: string, activeIncidents: number, blastRadius: string, rollbackAvailable: boolean, confidence: string): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN" {
    if (confidence === "UNKNOWN" || !Number.isFinite(reliability)) return "UNKNOWN";
    let score = 0;
    if (reliability < 0.5) score += 0.5;
    else if (reliability < 0.8) score += 0.15;
    if (sloState === "CRITICAL") score += 0.5;
    else if (sloState === "BREACHING") score += 0.3;
    if (activeIncidents > 0) score += 0.2;
    if (blastRadius === "CRITICAL" || blastRadius === "LARGE") score += 0.1;
    if (!rollbackAvailable) score += 0.3;
    score = Math.min(1, score);

    let risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "LOW";
    if (score > 0.8) risk = "CRITICAL";
    else if (score > 0.5) risk = "HIGH";
    else if (score > 0.25) risk = "MEDIUM";

    // Hard safety floor: CRITICAL blast radius must never be LOW
    if (blastRadius === "CRITICAL" && risk === "LOW") risk = "MEDIUM";
    return risk;
  }
}
