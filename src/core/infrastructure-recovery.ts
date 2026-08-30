export type RecoveryAction = "RETRY" | "REPLAN" | "ROLLBACK" | "WAIT" | "HUMAN_REVIEW";

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  requires_approval: boolean;
}

export class InfrastructureRecoveryService {
  private maxRetries = 2;
  private retryCounts = new Map<string, number>();

  decideRecovery(failureType: string, isDestructive: boolean, attempt: number): RecoveryDecision {
    if (isDestructive) return { action: "HUMAN_REVIEW", reason: "Destructive operation requires approval", requires_approval: true };
    if (attempt >= this.maxRetries) return { action: "HUMAN_REVIEW", reason: `Retry limit ${this.maxRetries} reached`, requires_approval: true };
    switch (failureType) {
      case "TIMEOUT":
      case "NETWORK_FAILURE":
        return { action: "RETRY", reason: "Transient failure", requires_approval: false };
      case "HEALTH_FAILURE":
        return { action: "REPLAN", reason: "Health check failed", requires_approval: false };
      default:
        return { action: "HUMAN_REVIEW", reason: "Unclassified failure", requires_approval: true };
    }
  }

  trackRetry(operationKey: string): number {
    const current = this.retryCounts.get(operationKey) ?? 0;
    const next = current + 1;
    this.retryCounts.set(operationKey, next);
    return next;
  }
}