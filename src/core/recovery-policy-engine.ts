export type RecoveryDecision = "AUTOMATIC" | "HUMAN_APPROVAL_REQUIRED" | "DENIED" | "BLOCKED";

export interface RecoveryAction {
  id: string;
  type: "restart" | "rollback" | "retry" | "scale" | "noop";
  service: string;
  environment: string;
  description: string;
}

/**
 * Phase 250: explicit authorization boundary for production remediation.
 * When absent, production restart/retry/scale are NOT automatically authorized.
 */
export interface RecoveryAuthorization {
  authorizedBy: string;
  reason?: string;
}

export class RecoveryPolicyEngine {
  private maxAutomaticAttempts = 2;

  /**
   * Evaluate a recovery action.
   *
   * Phase 250 changes production semantics:
   *   - rollback always requires human approval in production
   *   - restart/retry/scale require explicit RecoveryAuthorization in production
   *   - attempt budget still applies
   * Non-production semantics unchanged from prior phases.
   */
  evaluate(
    action: RecoveryAction,
    environment: string,
    attemptNumber: number,
    authorization?: RecoveryAuthorization,
  ): RecoveryDecision {
    if (environment === "production") {
      if (action.type === "rollback") return "HUMAN_APPROVAL_REQUIRED";

      if (!authorization || !authorization.authorizedBy || authorization.authorizedBy.length === 0) {
        return "HUMAN_APPROVAL_REQUIRED";
      }

      if (attemptNumber > this.maxAutomaticAttempts) return "HUMAN_APPROVAL_REQUIRED";
      return "AUTOMATIC";
    }

    if (action.type === "restart" || action.type === "retry") {
      return attemptNumber > this.maxAutomaticAttempts ? "HUMAN_APPROVAL_REQUIRED" : "AUTOMATIC";
    }
    if (action.type === "rollback") return "HUMAN_APPROVAL_REQUIRED";
    return "DENIED";
  }
}