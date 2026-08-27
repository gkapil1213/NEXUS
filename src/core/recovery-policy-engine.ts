export type RecoveryDecision = "AUTOMATIC" | "HUMAN_APPROVAL_REQUIRED" | "DENIED" | "BLOCKED";

export interface RecoveryAction {
  id: string;
  type: "restart" | "rollback" | "retry" | "scale" | "noop";
  service: string;
  environment: string;
  description: string;
}

export class RecoveryPolicyEngine {
  private maxAutomaticAttempts = 2;

  evaluate(action: RecoveryAction, environment: string, attemptNumber: number): RecoveryDecision {
    if (environment === "production") {
      if (action.type === "rollback") return "HUMAN_APPROVAL_REQUIRED";
      if (attemptNumber > this.maxAutomaticAttempts) return "HUMAN_APPROVAL_REQUIRED";
      return "AUTOMATIC";
    }
    // non-production
    if (action.type === "restart" || action.type === "retry") {
      return attemptNumber > this.maxAutomaticAttempts ? "HUMAN_APPROVAL_REQUIRED" : "AUTOMATIC";
    }
    if (action.type === "rollback") return "HUMAN_APPROVAL_REQUIRED";
    return "DENIED";
  }
}