// src/core/release-execution-gate.ts
// Phase 211: release execution safety gate.
//
// Composes existing infrastructure, does not duplicate it:
//   - Phase 210 evaluateReleaseSafety (evidence-backed authorization)
//   - ReleaseDeploymentIntentService (idempotent intent + distributed lease)
//   - ProductionReleaseEnforcementService (durable authorization + provider)
//
// Enforces Phase 210 authorization before any durable intent is created or
// any external execution is attempted. Fail-closed. No bypass path.

import {
  evaluateReleaseSafety,
  type ReleaseCandidate,
  type ReleaseSafetyDecision,
  type ReleaseSafetyPolicy,
  type ReleaseSafetyStatus,
} from "./release-safety-gate";
import type {
  ReleaseDeploymentIntentService,
  ReleaseIntentInput,
} from "./release-deployment-intent";
import type {
  ProductionReleaseEnforcementService,
  DeploymentResult,
} from "./production-release-enforcement";

export interface ReleaseExecutionInput {
  candidate: ReleaseCandidate;
  verificationRun: unknown;
  policy: ReleaseSafetyPolicy;
  intentInput: ReleaseIntentInput;
  authorizationId: string;
  attemptId: string;
}

export type ReleaseExecutionStatus =
  | "EXECUTED"
  | "REJECTED"
  | "BLOCKED"
  | "NOT_EXECUTED";

export interface ReleaseExecutionOutcome {
  status: ReleaseExecutionStatus;
  safetyVerdict: ReleaseSafetyStatus;
  safetyReasons: string[];
  resultDigest: string | null;
  evidenceDigest: string | null;
  intentKey: string | null;
  intentCreated: boolean;
  leaseHolder: string | null;
  deploymentResult: DeploymentResult | null;
}

export interface ReleaseExecutionGateDeps {
  intents: ReleaseDeploymentIntentService;
  enforcement: ProductionReleaseEnforcementService;
  workerId: string;
  leaseTtlMs?: number;
}

export class ReleaseExecutionGate {
  constructor(private readonly deps: ReleaseExecutionGateDeps) {}

  async execute(input: ReleaseExecutionInput): Promise<ReleaseExecutionOutcome> {
    // Step 1: Phase 210 evidence-backed authorization.
    let decision: ReleaseSafetyDecision;
    try {
      decision = evaluateReleaseSafety({
        candidate: input.candidate,
        verificationRun: input.verificationRun,
        policy: input.policy,
      });
    } catch (e) {
      return {
        status: "REJECTED",
        safetyVerdict: "REJECTED_MISSING",
        safetyReasons: ["gate_threw:" + (e instanceof Error ? e.message : String(e))],
        resultDigest: null,
        evidenceDigest: null,
        intentKey: null,
        intentCreated: false,
        leaseHolder: null,
        deploymentResult: null,
      };
    }

    if (!decision.allowed) {
      return {
        status: "REJECTED",
        safetyVerdict: decision.status,
        safetyReasons: decision.reasons,
        resultDigest: decision.resultDigest,
        evidenceDigest: decision.evidenceDigest,
        intentKey: null,
        intentCreated: false,
        leaseHolder: null,
        deploymentResult: null,
      };
    }

    // Step 2: idempotent durable intent creation.
    let intentKey: string;
    let intentCreated: boolean;
    try {
      const got = await this.deps.intents.getOrCreateAsync(input.intentInput);
      intentKey = got.intent.intentKey;
      intentCreated = got.created;
    } catch (e) {
      return {
        status: "BLOCKED",
        safetyVerdict: decision.status,
        safetyReasons: ["intent_create_failed:" + (e instanceof Error ? e.message : String(e))],
        resultDigest: decision.resultDigest,
        evidenceDigest: decision.evidenceDigest,
        intentKey: null,
        intentCreated: false,
        leaseHolder: null,
        deploymentResult: null,
      };
    }

    // Step 2b: refuse if the intent has already begun or completed execution.
    // The lease alone is insufficient: a fast successful run releases the
    // lease, and a second caller would legitimately re-acquire and re-execute.
    // The durable intent state is the authoritative "has this been started?"
    // signal, and the Phase 174 fencing below ensures only one caller can win
    // the DEPLOYING transition.
    const EXECUTABLE = new Set(["PENDING", "AUTHORIZED", "DEPLOYMENT_INTENT_CREATED"]);
    const current = await this.deps.intents.getAsync(intentKey);
    if (current && !EXECUTABLE.has(current.status)) {
      return {
        status: "BLOCKED",
        safetyVerdict: decision.status,
        safetyReasons: ["intent_already_" + current.status.toLowerCase()],
        resultDigest: decision.resultDigest,
        evidenceDigest: decision.evidenceDigest,
        intentKey,
        intentCreated,
        leaseHolder: null,
        deploymentResult: null,
      };
    }

    // Step 3: distributed lease (concurrency protection for this boundary).
    const lease = await this.deps.intents.acquireLeaseAsync(
      intentKey,
      this.deps.workerId,
      this.deps.leaseTtlMs,
    );
    if (!lease.acquired) {
      return {
        status: "BLOCKED",
        safetyVerdict: decision.status,
        safetyReasons: ["lease_held_by:" + (lease.holder ?? "unknown")],
        resultDigest: decision.resultDigest,
        evidenceDigest: decision.evidenceDigest,
        intentKey,
        intentCreated,
        leaseHolder: lease.holder,
        deploymentResult: null,
      };
    }

    // Step 3b: fenced transition PENDING/AUTHORIZED/DEPLOYMENT_INTENT_CREATED
    // -> DEPLOYING. Exactly one caller can win this CAS; losers return BLOCKED
    // with no side effects. This is the concurrency guarantee (prompt §21).
    const trans = await this.deps.intents.transitionIfOwnedAsync(
      intentKey,
      "DEPLOYING",
      this.deps.workerId,
      {},
      ["PENDING", "AUTHORIZED", "DEPLOYMENT_INTENT_CREATED"],
    );
    if (!trans.updated) {
      try { await this.deps.intents.releaseLeaseAsync(intentKey, this.deps.workerId); } catch { /* ignore */ }
      return {
        status: "BLOCKED",
        safetyVerdict: decision.status,
        safetyReasons: ["intent_transition_race_lost"],
        resultDigest: decision.resultDigest,
        evidenceDigest: decision.evidenceDigest,
        intentKey,
        intentCreated,
        leaseHolder: null,
        deploymentResult: null,
      };
    }

    // Step 4: delegate to existing enforcement service.
    try {
      const result = await this.deps.enforcement.executeRelease(
        input.authorizationId,
        input.candidate.releaseId,
        input.candidate.artifactId ?? "",
        input.candidate.commitSha,
        input.candidate.environment ?? "production",
        input.attemptId,
      );
      // DeploymentResult.status union varies across release-path modules in
      // this repo; compare via widened string so the mapping is explicit and
      // covers every observed literal.
      const s = String(result.status);
      const status: ReleaseExecutionStatus =
        s === "DEPLOYED" || s === "VERIFIED" ? "EXECUTED"
        : s === "UNKNOWN" ? "NOT_EXECUTED"
        : s === "EXECUTING" ? "EXECUTED"
        : s === "RECOVERY_REQUIRED" ? "NOT_EXECUTED"
        : "BLOCKED";

      // Step 4b: fenced terminal transition. Only the DEPLOYING owner can
      // advance; best-effort (a crash here leaves DEPLOYING, which recovery
      // reconciles via ReleaseRecoveryExecutor).
      const terminal =
        status === "EXECUTED" ? "KNOWN_GOOD"
        : status === "NOT_EXECUTED" ? "RECOVERY_REQUIRED"
        : "FAILED";
      try {
        await this.deps.intents.transitionIfOwnedAsync(
          intentKey, terminal, this.deps.workerId, {}, ["DEPLOYING"],
        );
      } catch { /* recovery supervisor handles partial completion */ }

      return {
        status,
        safetyVerdict: decision.status,
        safetyReasons: decision.reasons,
        resultDigest: decision.resultDigest,
        evidenceDigest: decision.evidenceDigest,
        intentKey,
        intentCreated,
        leaseHolder: this.deps.workerId,
        deploymentResult: result,
      };
    } finally {
      try { await this.deps.intents.releaseLeaseAsync(intentKey, this.deps.workerId); } catch { /* ignore */ }
    }
  }
}
