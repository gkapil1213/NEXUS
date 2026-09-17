// src/core/release-recovery-executor.ts
// Phase 104: durable production release recovery.
import type { DockerAdapter, SmokeTestService } from "./runtime";
import type { ReleaseDeploymentIntent } from "./execution-store";
import type {
  CanonicalDeploymentOrchestrator,
  CanonicalDeploymentRequest,
  CanonicalDeploymentOutcome,
} from "./deployment-orchestrator";
import type { DeploymentHistoryService } from "./deployment-history";
import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";
import type { ReleaseRecoveryService, RecoveryAction, RecoveryPlan } from "./release-recovery";
import { inspectIntentContainer } from "./release-recovery-inspection";

export interface RecoveryEventSink {
  emit(e: { type: string; source?: string; execution_id?: string | null; payload?: unknown }): Promise<unknown> | unknown;
}
export interface RecoveryAuditSink {
  record(e: { actor: string; action: string; resource_type: string; resource_id: string; result?: string; metadata?: unknown }): Promise<unknown> | unknown;
}
export interface RecoveryServices { events: RecoveryEventSink; audit: RecoveryAuditSink; }
export interface RollbackDelegate {
  rollback(intent: ReleaseDeploymentIntent): Promise<{ status: "COMPLETED" | "BLOCKED" | "FAILED"; deploymentId: string | null; message: string }>;
}
export interface ReleaseRecoveryExecutorDeps {
  intents: ReleaseDeploymentIntentService;
  recovery: ReleaseRecoveryService;
  orchestrator: CanonicalDeploymentOrchestrator;
  history: DeploymentHistoryService;
  docker: DockerAdapter;
  smoke: SmokeTestService;
  svc: RecoveryServices;
  workerId: string;
  leaseTtlMs?: number;
  rollback?: RollbackDelegate;
  /** Phase 119: independent verification after crash recovery. Called only when inspection finds
   *  the target immutable image already running. MUST NOT be implemented by re-invoking rollback. */
  verifyRecoveredRollback?: {
    // Phase 120: context carries the inspected verification URL.
    verify(intent: ReleaseDeploymentIntent, context?: {
      stagingUrl?: string;
      hostPort?: number;
    }): Promise<{
      status: "VERIFIED" | "BLOCKED" | "VERIFICATION_FAILED";
      message: string;
    }>;
  };
  /** Phase 123: post-run evidence reconciliation. Optional — when absent,
   *  behavior is byte-for-byte identical to Phase 122. */
  reconciler?: {
    reconcile(intentKey: string): Promise<unknown>;
  };
}
export interface RecoveryActionRecord { intentKey: string; action: RecoveryAction; reason: string; }
export interface RecoveryRunReport {
  scanned: number; acted: number; skipped: number; blocked: number; leaseHeld: number;
  actions: RecoveryActionRecord[];
  blockedReasons: Array<{ intentKey: string; reason: string }>;
}

export class ReleaseRecoveryExecutor {
  constructor(private readonly deps: ReleaseRecoveryExecutorDeps) {}

  async runOnce(now = Date.now()): Promise<RecoveryRunReport> {
    const { intents, recovery, svc } = this.deps;
    const report: RecoveryRunReport = { scanned: 0, acted: 0, skipped: 0, blocked: 0, leaseHeld: 0, actions: [], blockedReasons: [] };
    const recoverable = intents.listRecoverable();
    report.scanned = recoverable.length;
    await svc.events.emit({ type: "release.recovery.started", source: "ReleaseRecoveryExecutor", payload: { scanned: recoverable.length, workerId: this.deps.workerId } });
    for (const intent of recoverable) {
      try {
        const plan = recovery.classify({ intent, now });
        report.actions.push({ intentKey: intent.intentKey, action: plan.action, reason: plan.reason });
        await this.dispatch(intent, plan, report);
      } catch (e) {
        report.blocked++;
        const reason = e instanceof Error ? e.message : String(e);
        report.blockedReasons.push({ intentKey: intent.intentKey, reason });
        await svc.events.emit({ type: "release.recovery.error", source: "ReleaseRecoveryExecutor", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, error: reason } });
      }
    }
    // Phase 123: post-run evidence reconciliation for ROLLBACK-kind intents.
    // Terminal states are not returned by listRecoverable(), so we scan them.
    if (this.deps.reconciler) {
      const seen = new Set<string>();
      const terminalStatuses = ["FAILED", "VERIFICATION_FAILED", "RECOVERY_REQUIRED", "BLOCKED"] as const;
      for (const status of terminalStatuses) {
        for (const intent of intents.listByStatus(status)) {
          const kind = ((intent as unknown as { intentKind?: string }).intentKind ?? "DEPLOY");
          if (kind !== "ROLLBACK") continue;
          if (seen.has(intent.intentKey)) continue;
          seen.add(intent.intentKey);
          // Phase 124: reconciliation writes durable state (reconciled event +
          // audit record). Lease-gate it exactly like every other mutating
          // path in this executor so two workers cannot both reconcile the
          // same intent. If the lease is held, skip; the obligation stays
          // durable and is rediscovered on the next runOnce().
          const reconcileLease = intents.acquireLease(intent.intentKey, this.deps.workerId, this.deps.leaseTtlMs);
          if (!reconcileLease.acquired) {
            report.leaseHeld++;
            await svc.events.emit({ type: "release.recovery.lease.held", source: "ReleaseRecoveryExecutor", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, holder: reconcileLease.holder, expiresAt: reconcileLease.expiresAt, phase: "reconcile" } });
            continue;
          }
          try {
            await this.deps.reconciler.reconcile(intent.intentKey);          } catch (e) {
            report.blocked++;
            const reason = e instanceof Error ? e.message : String(e);
            report.blockedReasons.push({ intentKey: intent.intentKey, reason: "reconciliation failed: " + reason });
            await svc.events.emit({ type: "release.recovery.error", source: "ReleaseRecoveryExecutor", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, error: "reconciliation failed: " + reason } });
          } finally {
            intents.releaseLease(intent.intentKey, this.deps.workerId);
          }
        }
      }
    }    await svc.events.emit({ type: "release.recovery.completed", source: "ReleaseRecoveryExecutor", payload: { scanned: report.scanned, acted: report.acted, skipped: report.skipped, blocked: report.blocked, leaseHeld: report.leaseHeld } });
    return report;
  }

  private async dispatch(intent: ReleaseDeploymentIntent, plan: RecoveryPlan, report: RecoveryRunReport): Promise<void> {
    switch (plan.action) {
      case "ALREADY_KNOWN_GOOD":
      case "ALREADY_FAILED":
      case "ALREADY_BLOCKED":
      case "ALREADY_CANCELLED": report.skipped++; return;
      case "RESUME_FROM_INTENT": await this.resumeFromIntent(intent, report); return;
      case "RESUME_VERIFICATION": await this.resumeVerification(intent, report); return;
      case "MARK_FAILED_AND_ROLLBACK": await this.markFailedAndRollback(intent, report); return;
      case "RESUME_ROLLBACK": await this.resumeRollback(intent, report); return;
      case "RECOVERY_REQUIRED": await this.handleRecoveryRequired(intent, plan, report); return;
      default: { const _ex: never = plan.action; void _ex; report.blocked++; report.blockedReasons.push({ intentKey: intent.intentKey, reason: "unknown recovery action" }); return; }
    }
  }

  private async resumeFromIntent(intent: ReleaseDeploymentIntent, report: RecoveryRunReport): Promise<void> {
    const { intents, svc } = this.deps;
    if (intent.status === "AUTHORIZED") {
      if (!this.isImmutableComplete(intent)) { await this.blockIntent(intent, "authorized intent missing immutable fields", report); return; }
      intents.transition(intent.intentKey, "DEPLOYMENT_INTENT_CREATED", { recoveryReason: "recovery: AUTHORIZED -> DEPLOYMENT_INTENT_CREATED" });
      report.acted++;
      await svc.events.emit({ type: "release.recovery.advanced", source: "ReleaseRecoveryExecutor", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, from: "AUTHORIZED", to: "DEPLOYMENT_INTENT_CREATED" } });
      return;
    }
    if (intent.status === "DEPLOYMENT_INTENT_CREATED") {
      if (!intent.projectId) { await this.blockIntent(intent, "projectId required to deploy", report); return; }
      if (!this.isImmutableComplete(intent)) { await this.blockIntent(intent, "intent missing immutable fields", report); return; }
      const lease = intents.acquireLease(intent.intentKey, this.deps.workerId, this.deps.leaseTtlMs);
      if (!lease.acquired) { report.leaseHeld++; await svc.events.emit({ type: "release.recovery.lease.held", source: "ReleaseRecoveryExecutor", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, holder: lease.holder, expiresAt: lease.expiresAt } }); return; }
      try {
        const fresh = intents.get(intent.intentKey);
        if (!fresh || fresh.status !== "DEPLOYMENT_INTENT_CREATED") { report.skipped++; return; }
        intents.transition(fresh.intentKey, "DEPLOYING", { recoveryReason: "recovery: deploying under lease " + this.deps.workerId });
        const outcome = await this.deps.orchestrator.deploy(this.toDeploymentRequest(fresh));
        await this.recordDeploymentOutcome(fresh, outcome, report);
      } finally { intents.releaseLease(intent.intentKey, this.deps.workerId); }
      return;
    }
    await this.blockIntent(intent, "resume_from_intent but status " + intent.status, report);
  }

  private async resumeVerification(intent: ReleaseDeploymentIntent, report: RecoveryRunReport): Promise<void> {
    const { intents } = this.deps;
    if (!intent.projectId) { await this.blockIntent(intent, "projectId required to resume verification", report); return; }
    if (!intent.deploymentId) { await this.blockIntent(intent, "no deploymentId to resume verification", report); return; }
    const lease = intents.acquireLease(intent.intentKey, this.deps.workerId, this.deps.leaseTtlMs);
    if (!lease.acquired) { report.leaseHeld++; return; }
    try {
      const fresh = intents.get(intent.intentKey);
      if (!fresh || (fresh.status !== "HEALTH_CHECKING" && fresh.status !== "SMOKE_TESTING")) { report.skipped++; return; }
      const inspection = await inspectIntentContainer(fresh, this.deps.docker);
      if (inspection.verdict === "BLOCKED") { await this.markRecoveryRequired(fresh, "inspection blocked: " + inspection.reason); report.blocked++; return; }
      if (inspection.verdict === "MISSING") { await this.markRecoveryRequired(fresh, "container missing on resume verification"); report.blocked++; return; }
      if (inspection.verdict === "IDENTITY_MISMATCH") { intents.transition(fresh.intentKey, "VERIFICATION_FAILED", { failureReason: "identity mismatch on resume: expected " + inspection.expectedImageId + " got " + inspection.runningImageId }); report.acted++; return; }
      if (!inspection.hostPort) { await this.markRecoveryRequired(fresh, "no host port on inspect"); report.blocked++; return; }
      const stagingUrl = "http://127.0.0.1:" + inspection.hostPort;
      const smokeResult = await this.deps.smoke.run({ staging_url: stagingUrl, execution_id: fresh.executionId });
      if (smokeResult.verdict === "PASS") {
        intents.transition(fresh.intentKey, "KNOWN_GOOD", { deploymentId: fresh.deploymentId });
        report.acted++;
        await this.deps.svc.events.emit({ type: "release.recovery.known_good", source: "ReleaseRecoveryExecutor", execution_id: fresh.executionId, payload: { intentKey: fresh.intentKey, deploymentId: fresh.deploymentId } });
      } else if (smokeResult.verdict === "BLOCKED") { await this.markRecoveryRequired(fresh, "smoke blocked on resume"); report.blocked++; }
      else { intents.transition(fresh.intentKey, "VERIFICATION_FAILED", { failureReason: "smoke failed on resume" }); report.acted++; }
    } finally { intents.releaseLease(intent.intentKey, this.deps.workerId); }
  }

  private async markFailedAndRollback(intent: ReleaseDeploymentIntent, report: RecoveryRunReport): Promise<void> {
    const { intents, svc } = this.deps;
    if (!intent.projectId) { await this.blockIntent(intent, "projectId required for rollback", report); return; }
    const lease = intents.acquireLease(intent.intentKey, this.deps.workerId, this.deps.leaseTtlMs);
    if (!lease.acquired) { report.leaseHeld++; return; }
    try {
      const fresh = intents.get(intent.intentKey);
      if (!fresh || fresh.status !== "VERIFICATION_FAILED") { report.skipped++; return; }
      intents.transition(fresh.intentKey, "ROLLING_BACK", { recoveryReason: "recovery: verification failed -> rollback" });
      if (!this.deps.rollback) {
        intents.transition(fresh.intentKey, "FAILED", { failureReason: "verification failed; rollback delegate unavailable" });
        report.blocked++;
        report.blockedReasons.push({ intentKey: fresh.intentKey, reason: "rollback delegate unavailable" });
        await svc.events.emit({ type: "release.recovery.rollback.unavailable", source: "ReleaseRecoveryExecutor", execution_id: fresh.executionId, payload: { intentKey: fresh.intentKey } });
        return;
      }
      const result = await this.deps.rollback.rollback(fresh);
      intents.transition(fresh.intentKey, result.status === "COMPLETED" ? "FAILED" : "BLOCKED", { deploymentId: result.deploymentId, failureReason: result.message });
      if (result.status === "COMPLETED") report.acted++; else report.blocked++;
      await svc.audit.record({ actor: this.deps.workerId, action: "release.recovery.rollback", resource_type: "release_deployment_intent", resource_id: fresh.intentKey, result: result.status === "COMPLETED" ? "ok" : "blocked", metadata: { message: result.message } });
    } finally { intents.releaseLease(intent.intentKey, this.deps.workerId); }
  }

  private async resumeRollback(intent: ReleaseDeploymentIntent, report: RecoveryRunReport): Promise<void> {
    const { intents } = this.deps;
    if (!intent.projectId) { await this.blockIntent(intent, "projectId required to resume rollback", report); return; }
    const lease = intents.acquireLease(intent.intentKey, this.deps.workerId, this.deps.leaseTtlMs);
    if (!lease.acquired) { report.leaseHeld++; return; }
    try {
      const fresh = intents.get(intent.intentKey);
      if (!fresh || fresh.status !== "ROLLING_BACK") { report.skipped++; return; }
      const inspection = await inspectIntentContainer(fresh, this.deps.docker);
      if (inspection.verdict === "BLOCKED") { report.blocked++; report.blockedReasons.push({ intentKey: fresh.intentKey, reason: "rollback resume: inspection blocked" }); return; }
      if (inspection.verdict === "MISSING") { await this.markRecoveryRequired(fresh, "rollback resume: container missing"); report.blocked++; return; }
      if (inspection.verdict === "MATCHES_INTENT") {
        const isRollbackKind = ((fresh as any).intentKind ?? "DEPLOY") === "ROLLBACK";
        if (isRollbackKind) {
          // Phase 119: target image already running. Do NOT invoke rollback again.
          if (!this.deps.verifyRecoveredRollback) {
            await this.markRecoveryRequired(fresh, "target image already active; recovery verification delegate unavailable");
            report.blocked++;
            return;
          }
          // Phase 121: durable evidence base for crash-recovery verification.
          if (!inspection.hostPort) {
            await this.markRecoveryRequired(fresh, "target image active but no mapped host port on inspect");
            report.blocked++;
            return;
          }
          const stagingUrl = "http://127.0.0.1:" + inspection.hostPort;

          const evidenceBase = {
            intentKey: fresh.intentKey,
            intentKind: "ROLLBACK" as const,
            executionId: fresh.executionId,
            projectId: fresh.projectId,
            releaseId: fresh.releaseId,
            rollbackTargetReleaseId: fresh.rollbackTargetReleaseId ?? null,
            artifactId: fresh.artifactId,
            expectedArtifactDigest: fresh.artifactDigest,
            expectedImageId: inspection.expectedImageId,
            observedContainerId: inspection.containerId,
            observedImageId: inspection.runningImageId,
            hostPort: inspection.hostPort,
            stagingUrl,
            recoveryWorkerId: this.deps.workerId,
            timestamp: Date.now(),
          };

          await this.deps.svc.events.emit({
            type: "release.recovery.rollback.verification_started",
            source: "ReleaseRecoveryExecutor",
            execution_id: fresh.executionId,
            payload: evidenceBase,
          });

          let ver;
          try {
            ver = await this.deps.verifyRecoveredRollback.verify(fresh, {
              stagingUrl,
              hostPort: inspection.hostPort,
            });
          } catch (err) {
            const errMsg = (err as Error).message ?? String(err);
            await this.deps.svc.events.emit({
              type: "release.recovery.rollback.verification_blocked",
              source: "ReleaseRecoveryExecutor",
              execution_id: fresh.executionId,
              payload: { ...evidenceBase, verificationStatus: "EXCEPTION", reason: errMsg },
            });
            await this.markRecoveryRequired(fresh, "recovery verification threw: " + errMsg);
            report.blocked++;
            return;
          }

          if (ver.status === "VERIFIED") {
            await this.deps.svc.events.emit({
              type: "release.recovery.rollback.verification_passed",
              source: "ReleaseRecoveryExecutor",
              execution_id: fresh.executionId,
              payload: { ...evidenceBase, verificationStatus: "VERIFIED", reason: ver.message },
            });
            intents.transition(fresh.intentKey, "FAILED", { recoveryReason: "rollback verified after crash recovery" });
            report.acted++;
            await this.deps.svc.events.emit({
              type: "release.recovery.rollback.verified",
              source: "ReleaseRecoveryExecutor",
              execution_id: fresh.executionId,
              payload: { ...evidenceBase, verificationStatus: "VERIFIED", reason: ver.message },
            });
            return;
          }

          if (ver.status === "BLOCKED") {
            await this.deps.svc.events.emit({
              type: "release.recovery.rollback.verification_blocked",
              source: "ReleaseRecoveryExecutor",
              execution_id: fresh.executionId,
              payload: { ...evidenceBase, verificationStatus: "BLOCKED", reason: ver.message },
            });
            await this.markRecoveryRequired(fresh, "recovery verification blocked: " + ver.message);
            report.blocked++;
            return;
          }

          await this.deps.svc.events.emit({
            type: "release.recovery.rollback.verification_failed",
            source: "ReleaseRecoveryExecutor",
            execution_id: fresh.executionId,
            payload: { ...evidenceBase, verificationStatus: "VERIFICATION_FAILED", reason: ver.message },
          });
          intents.transition(fresh.intentKey, "VERIFICATION_FAILED", { failureReason: ver.message });
          report.acted++;
          return;
        }
        // Legacy DEPLOY-intent path — preserved for canonical suite T78.
        if (!this.deps.rollback) { intents.transition(fresh.intentKey, "BLOCKED", { failureReason: "rollback in flight; delegate unavailable" }); report.blocked++; return; }
        const result = await this.deps.rollback.rollback(fresh);
        intents.transition(fresh.intentKey, result.status === "COMPLETED" ? "FAILED" : "BLOCKED", { failureReason: result.message });
        if (result.status === "COMPLETED") report.acted++; else report.blocked++;
        return;
      }
      intents.transition(fresh.intentKey, "FAILED", { failureReason: "rollback already completed; terminal" });
      report.skipped++;
    } finally { intents.releaseLease(intent.intentKey, this.deps.workerId); }
  }

  private async handleRecoveryRequired(intent: ReleaseDeploymentIntent, plan: RecoveryPlan, report: RecoveryRunReport): Promise<void> {
    const { intents } = this.deps;
    if (!plan.requiresDockerInspection) { report.blocked++; report.blockedReasons.push({ intentKey: intent.intentKey, reason: plan.reason }); return; }
    const lease = intents.acquireLease(intent.intentKey, this.deps.workerId, this.deps.leaseTtlMs);
    if (!lease.acquired) { report.leaseHeld++; return; }
    try {
      const fresh = intents.get(intent.intentKey);
      if (!fresh) { report.skipped++; return; }
      const inspection = await inspectIntentContainer(fresh, this.deps.docker);
      if (inspection.verdict === "MATCHES_INTENT") { intents.transition(fresh.intentKey, "HEALTH_CHECKING", { recoveryReason: "recovery: container matches intent -> HEALTH_CHECKING" }); report.acted++; return; }
      if (inspection.verdict === "IDENTITY_MISMATCH") { intents.transition(fresh.intentKey, "VERIFICATION_FAILED", { failureReason: "recovery: container identity mismatch on resume" }); report.acted++; return; }
      if (inspection.verdict === "MISSING") { await this.markRecoveryRequired(fresh, "container missing on recovery; manual review required"); report.blocked++; return; }
      report.blocked++;
      await this.markRecoveryRequired(fresh, "inspection blocked: " + inspection.reason);
      report.blockedReasons.push({ intentKey: fresh.intentKey, reason: "inspection blocked: " + inspection.reason });
    } finally { intents.releaseLease(intent.intentKey, this.deps.workerId); }
  }

  private async recordDeploymentOutcome(intent: ReleaseDeploymentIntent, outcome: CanonicalDeploymentOutcome, report: RecoveryRunReport): Promise<void> {
    const { intents, svc } = this.deps;
    const status = outcome.deployment.status;
    const deploymentId = outcome.deployment.id;
    if (status === "KNOWN_GOOD") {
      intents.transition(intent.intentKey, "KNOWN_GOOD", { deploymentId });
      report.acted++;
      await svc.events.emit({ type: "release.recovery.known_good", source: "ReleaseRecoveryExecutor", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, deploymentId } });
      return;
    }
    if (status === "BLOCKED") { intents.transition(intent.intentKey, "BLOCKED", { deploymentId, failureReason: "deployment blocked" }); report.blocked++; return; }
    intents.transition(intent.intentKey, "FAILED", { deploymentId, failureReason: "deployment failed" });
    report.acted++;
  }

  private toDeploymentRequest(intent: ReleaseDeploymentIntent): CanonicalDeploymentRequest {
    return {
      project_id: intent.projectId!,
      environment: intent.environment,
      release_id: intent.releaseId,
      commit_sha: intent.commitSha,
      artifact_id: intent.artifactId,
      execution_id: intent.executionId,
      image_repository: intent.imageRepository,
      image_tag: intent.imageTag,
      image_id: intent.imageId,
      image_digest: intent.imageDigest,
      container_name: intent.containerName,
      container_port: intent.containerPort,
    };
  }

  private isImmutableComplete(intent: ReleaseDeploymentIntent): boolean {
    return !!(intent.releaseId && intent.executionId && intent.artifactId && intent.artifactDigest && intent.commitSha && intent.environment && intent.imageRepository && intent.imageTag && intent.imageDigest && intent.containerName && intent.containerPort > 0);
  }

  private async blockIntent(intent: ReleaseDeploymentIntent, reason: string, report: RecoveryRunReport): Promise<void> {
    report.blocked++;
    report.blockedReasons.push({ intentKey: intent.intentKey, reason });
    await this.deps.svc.events.emit({ type: "release.recovery.blocked", source: "ReleaseRecoveryExecutor", execution_id: intent.executionId, payload: { intentKey: intent.intentKey, reason } });
  }

  private async markRecoveryRequired(intent: ReleaseDeploymentIntent, reason: string): Promise<void> {
    this.deps.intents.transition(intent.intentKey, "RECOVERY_REQUIRED", { recoveryReason: reason });
    await this.deps.svc.audit.record({ actor: this.deps.workerId, action: "release.recovery.required", resource_type: "release_deployment_intent", resource_id: intent.intentKey, result: "info", metadata: { reason } });
  }
}