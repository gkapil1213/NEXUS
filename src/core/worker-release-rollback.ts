export class WorkerReleaseRollback {
  evaluate(rollbackAvailable: boolean, schemaCompatible: boolean, rollbackRisk: number): "ROLLBACK_ALLOWED" | "ROLLBACK_BLOCKED" | "ROLLBACK_DEFERRED" | "MANUAL_INTERVENTION_REQUIRED" {
    if (!rollbackAvailable || !schemaCompatible) return "ROLLBACK_BLOCKED";
    if (rollbackRisk > 0.7) return "MANUAL_INTERVENTION_REQUIRED";
    if (rollbackRisk > 0.4) return "ROLLBACK_DEFERRED";
    return "ROLLBACK_ALLOWED";
  }
}
