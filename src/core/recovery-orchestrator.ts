import { RecoveryPolicyEngine } from "./recovery-policy-engine";
import { RecoveryStore } from "./recovery-store";
import { RecoveryVerifier } from "./recovery-verifier";
import {
  RecoveryAction,
  RecoveryDecision,
  RecoveryAttemptRecord,
  RecoveryLifecycleState,
} from "./recovery-models";
import { IncidentAnalysis } from "./incident-analysis";

export interface OrchestrationResult {
  attempt: RecoveryAttemptRecord;
  finalState: RecoveryLifecycleState;
}

export class RecoveryOrchestrator {
  constructor(
    private store: RecoveryStore,
    private policy: RecoveryPolicyEngine,
    private verifier: RecoveryVerifier,
  ) {}

  async orchestrate(
    diagnosis: IncidentAnalysis,
    environment: string,
    actionType: RecoveryAction["type"] = "restart",
    serviceName?: string,
    executionFn?: () => Promise<boolean>,
  ): Promise<OrchestrationResult> {
    const service = serviceName || diagnosis.service;
    const incidentId = diagnosis.incidentId;

    // Determine attempt number based on existing attempts
    const existingAttempts = this.store.listAttemptsForIncident(incidentId);
    const attemptNumber = existingAttempts.length + 1;

    // Idempotency: create a deterministic key
    const idempotencyKey = `${incidentId}:${actionType}:${service}:${attemptNumber}`;
    const existing = this.store.getAttemptByIdempotencyKey(idempotencyKey);
    if (existing) {
      // Already processed; return it
      return { attempt: existing, finalState: existing.status };
    }

    const action: RecoveryAction = {
      id: `recovery_${incidentId}_${attemptNumber}`,
      type: actionType,
      service,
      environment,
      description: `Automated ${actionType} for ${service}`,
    };

    // Policy evaluation
    const decision = this.policy.evaluate(action, environment, attemptNumber);

    // Create attempt record
    const attempt: RecoveryAttemptRecord = {
      id: `attempt_${incidentId}_${attemptNumber}`,
      incidentId,
      attemptNumber,
      action,
      decision,
      status: decision === "AUTOMATIC" ? "EXECUTING" : decision === "HUMAN_APPROVAL_REQUIRED" ? "HUMAN_REVIEW_REQUIRED" : "BLOCKED",
      evidence: [],
      startedAt: Date.now(),
      idempotencyKey,
    };

    this.store.addAttempt(attempt);

    // If not automatic, stop here
    if (decision !== "AUTOMATIC") {
      return { attempt, finalState: attempt.status };
    }

    // Execute
    let executionSuccess = false;
    let errorMsg: string | undefined;
    if (executionFn) {
      try {
        executionSuccess = await executionFn();
        attempt.evidence.push(executionSuccess ? "Execution reported success" : "Execution reported failure");
      } catch (err: any) {
        executionSuccess = false;
        errorMsg = err?.message || String(err);
        attempt.evidence.push(`Execution error: ${errorMsg}`);
        attempt.error = errorMsg;
      }
    } else {
      attempt.evidence.push("No execution function provided; simulated as failure");
      errorMsg = "No execution function provided";
      attempt.error = errorMsg;
    }

    if (!executionSuccess) {
      attempt.status = "FAILED";
      this.store.updateAttempt(attempt);
      return { attempt, finalState: attempt.status };
    }

    // Verification
    attempt.status = "VERIFYING";
    this.store.updateAttempt(attempt);
    let verified = false;
    try {
      verified = await this.verifier.verify(service, environment);
    } catch (err: any) {
      attempt.evidence.push(`Verification error: ${err?.message || String(err)}`);
    }
    attempt.verificationResult = verified;
    attempt.evidence.push(verified ? "Verification succeeded" : "Verification failed");

    if (verified) {
      attempt.status = "RECOVERED";
    } else {
      attempt.status = "FAILED";
    }
    this.store.updateAttempt(attempt);

    return { attempt, finalState: attempt.status };
  }
}