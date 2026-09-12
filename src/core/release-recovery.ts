// src/core/release-recovery.ts
// Phase 103: crash recovery classifier for in-flight release deployment
// intents. Given a persisted intent (and optionally a DockerAdapter + smoke
// service to inspect real state), classify what action is safe.
//
// This service NEVER transitions an intent to KNOWN_GOOD. It only classifies.
// KNOWN_GOOD can be reached only through the normal bridge + orchestrator
// verification path when re-run for real.

import type { ReleaseDeploymentIntent } from "./execution-store";

export type RecoveryAction =
  | "RESUME_FROM_INTENT"          // intent valid, no work done yet — safe to deploy
  | "RESUME_VERIFICATION"          // deployment exists, resume health/smoke
  | "MARK_FAILED_AND_ROLLBACK"    // verification failed, rollback required
  | "RESUME_ROLLBACK"             // rollback in flight, resume
  | "ALREADY_KNOWN_GOOD"           // terminal, no action
  | "ALREADY_FAILED"               // terminal, no action
  | "ALREADY_BLOCKED"              // terminal, no action
  | "RECOVERY_REQUIRED";          // ambiguous — must not proceed without human review

export interface RecoveryPlan {
  intentKey: string;
  action: RecoveryAction;
  reason: string;
  /** When true, the caller MUST NOT invoke CanonicalDeploymentOrchestrator.deploy() again without further validation. */
  requiresDockerInspection: boolean;
}

export interface RecoveryInput {
  intent: ReleaseDeploymentIntent;
  now?: number;
}

export class ReleaseRecoveryService {
  /**
   * Pure classification. No side effects. Docker inspection is a caller
   * responsibility driven by `requiresDockerInspection`.
   */
  classify(input: RecoveryInput): RecoveryPlan {
    const now = input.now ?? Date.now();
    const i = input.intent;

    switch (i.status) {
      case "PENDING":
        return {
          intentKey: i.intentKey,
          action: "RECOVERY_REQUIRED",
          reason: "pending intent requires durable lifecycle validation",
          requiresDockerInspection: false,
        };

      case "AUTHORIZED":
        // Authorization recorded but no intent created. Safe only if intent fields are complete.
        if (!this.isIntentComplete(i)) {
          return {
            intentKey: i.intentKey,
            action: "RECOVERY_REQUIRED",
            reason: "authorized intent missing immutable fields",
            requiresDockerInspection: false,
          };
        }
        return {
          intentKey: i.intentKey,
          action: "RESUME_FROM_INTENT",
          reason: "authorized, safe to create intent and deploy",
          requiresDockerInspection: false,
        };

      case "DEPLOYMENT_INTENT_CREATED":
        return {
          intentKey: i.intentKey,
          action: "RESUME_FROM_INTENT",
          reason: "intent created but no deployment started",
          requiresDockerInspection: false,
        };

      case "DEPLOYING":
        // We don't know whether docker run actually fired. MUST inspect.
        return {
          intentKey: i.intentKey,
          action: "RECOVERY_REQUIRED",
          reason: "deployment was in progress — real container state must be inspected before resume",
          requiresDockerInspection: true,
        };

      case "HEALTH_CHECKING":
      case "SMOKE_TESTING":
        // Container exists and identity was verified; verification was interrupted.
        // Caller may inspect deploymentId and re-run verification against the same container.
        if (!i.deploymentId) {
          return {
            intentKey: i.intentKey,
            action: "RECOVERY_REQUIRED",
            reason: i.status + " without deployment_id — cannot locate container",
            requiresDockerInspection: true,
          };
        }
        return {
          intentKey: i.intentKey,
          action: "RESUME_VERIFICATION",
          reason: i.status + " — deployment exists, resume verification against deployment_id " + i.deploymentId,
          requiresDockerInspection: true,
        };

      case "ROLLING_BACK":
        return {
          intentKey: i.intentKey,
          action: "RESUME_ROLLBACK",
          reason: "rollback was in progress",
          requiresDockerInspection: true,
        };

      case "VERIFICATION_FAILED":
        return {
          intentKey: i.intentKey,
          action: "MARK_FAILED_AND_ROLLBACK",
          reason: "verification failed — rollback required",
          requiresDockerInspection: false,
        };

      case "KNOWN_GOOD":
        return {
          intentKey: i.intentKey,
          action: "ALREADY_KNOWN_GOOD",
          reason: "terminal state — no recovery needed",
          requiresDockerInspection: false,
        };

      case "FAILED":
        return {
          intentKey: i.intentKey,
          action: "ALREADY_FAILED",
          reason: "terminal state — no recovery needed",
          requiresDockerInspection: false,
        };

      case "BLOCKED":
        return {
          intentKey: i.intentKey,
          action: "ALREADY_BLOCKED",
          reason: "terminal state — no recovery needed",
          requiresDockerInspection: false,
        };

      case "RECOVERY_REQUIRED":
        return {
          intentKey: i.intentKey,
          action: "RECOVERY_REQUIRED",
          reason: "already marked recovery_required",
          requiresDockerInspection: true,
        };

      default: {
        const _exhaustive: never = i.status;
        return {
          intentKey: i.intentKey,
          action: "RECOVERY_REQUIRED",
          reason: "unknown status: " + String(_exhaustive),
          requiresDockerInspection: true,
        };
      }
    }
  }

  /** Classify every recoverable intent. */
  classifyAll(intents: ReleaseDeploymentIntent[], now = Date.now()): RecoveryPlan[] {
    return intents.map((intent) => this.classify({ intent, now }));
  }

  private isIntentComplete(i: ReleaseDeploymentIntent): boolean {
    return !!(i.releaseId && i.executionId && i.artifactId && i.artifactDigest
      && i.imageRepository && i.imageTag && i.imageDigest && i.containerName
      && i.containerPort > 0);
  }
}
