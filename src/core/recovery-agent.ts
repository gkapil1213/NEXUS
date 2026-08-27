import { RecoveryPolicyEngine, RecoveryAction, RecoveryDecision } from "./recovery-policy-engine";
import { IncidentAnalysis } from "./incident-analysis";

export interface RecoveryAttempt {
  attempt: number;
  action: RecoveryAction;
  decision: RecoveryDecision;
  status: "EXECUTED" | "BLOCKED" | "FAILED" | "HUMAN_REVIEW_REQUIRED";
  evidence: string[];
  timestamp: string;
}

export class RecoveryAgent {
  constructor(private policy: RecoveryPolicyEngine) {}

  async attemptRecovery(
    diagnosis: IncidentAnalysis,
    incidentId: string,
    environment: string,
    attempts: RecoveryAttempt[],
    recoveryFn?: () => Promise<boolean>,
  ): Promise<RecoveryAttempt> {
    const attemptNumber = attempts.length + 1;
    const action: RecoveryAction = {
      id: `recovery_${incidentId}_${attemptNumber}`,
      type: "restart",
      service: "nexus-test-service",
      environment,
      description: "Restart unhealthy service",
    };

    const decision = this.policy.evaluate(action, environment, attemptNumber);
    if (decision !== "AUTOMATIC") {
      return {
        attempt: attemptNumber,
        action,
        decision,
        status: decision === "HUMAN_APPROVAL_REQUIRED" ? "HUMAN_REVIEW_REQUIRED" : "BLOCKED",
        evidence: [],
        timestamp: new Date().toISOString(),
      };
    }

    // Execute recovery if function provided
    let success = false;
    let evidence: string[] = [];
    if (recoveryFn) {
      success = await recoveryFn();
      evidence.push(success ? "Recovery action completed successfully" : "Recovery action failed");
    } else {
      evidence.push("No recovery function provided; recovery not executed");
      success = false;
    }

    return {
      attempt: attemptNumber,
      action,
      decision,
      status: success ? "EXECUTED" : "FAILED",
      evidence,
      timestamp: new Date().toISOString(),
    };
  }
}