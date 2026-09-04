export type SavingsStatus = "projected_savings" | "estimated_savings" | "observed_savings" | "verified_savings" | "unknown_savings";

export class WorkerCostSavingsVerifier {
  verify(actualCost: number, expectedCost: number, evidenceSource: string): SavingsStatus {
    if (!Number.isFinite(actualCost) || !Number.isFinite(expectedCost) || expectedCost === 0) return "unknown_savings";
    const savings = expectedCost - actualCost;
    if (savings <= 0) return "unknown_savings";
    if (evidenceSource === "provider_reported" || evidenceSource === "observed") return "observed_savings";
    if (evidenceSource === "metered") return "estimated_savings";
    return "projected_savings";
  }
}
