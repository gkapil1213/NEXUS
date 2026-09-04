export type ScalingRollbackDecision = "ROLLBACK_ALLOWED" | "ROLLBACK_BLOCKED" | "ROLLBACK_DEFERRED";

export class WorkerScalingRollback {
  evaluate(rollbackAvailable: boolean, safetyGateResult: string, currentState: string): ScalingRollbackDecision {
    if (!rollbackAvailable || safetyGateResult !== "ALLOW") return "ROLLBACK_BLOCKED";
    if (currentState === "CRITICAL") return "ROLLBACK_DEFERRED";
    return "ROLLBACK_ALLOWED";
  }
}
