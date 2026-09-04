export class WorkerDecisionAuthorization {
  authorize(safetyResult: string, epochValid: boolean, ownershipValid: boolean): "AUTHORIZED" | "DENIED" | "STALE" {
    if (!epochValid || !ownershipValid) return "STALE";
    if (safetyResult !== "ALLOW") return "DENIED";
    return "AUTHORIZED";
  }
}
