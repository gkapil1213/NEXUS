import { createRelease } from './worker-phase25-release';
import { createDeploymentPlan } from './worker-phase25-deployment-plan';
import { createDeploymentExecution, transitionDeploymentExecution } from './worker-phase25-deployment-execution';
import { advanceRollout, ProgressiveDeliveryState } from './worker-phase25-progressive-delivery';
import { evaluateHealthGate } from './worker-phase25-health-gate';
import { createDeploymentHalt } from './worker-phase25-deployment-halt';
import { createRollbackExecution, transitionRollbackExecution } from './worker-phase25-deployment-rollback';
import { evaluateRollbackSafety } from './worker-phase25-rollback-safety';
import { evaluateDeploymentCircuitBreaker } from './worker-phase25-deployment-circuit-breaker';
import { createReleaseFreeze } from './worker-phase25-release-freeze';
import { createDeploymentIncident } from './worker-phase25-deployment-incident';
import { createDeploymentEvidence } from './worker-phase25-deployment-evidence';
import { createDeploymentAuditEvent } from './worker-phase25-deployment-audit';
import { addReleaseLineageNode, ReleaseLineage } from './worker-phase25-release-lineage';
import { DeploymentAdapter, unavailableDeploymentAdapter } from './worker-deployment-adapter'; // existing
import type { ExecutionStore } from './execution-store';
import type { ExecutionJob } from './execution-models';

export interface AutonomousReleaseDeploymentRequest {
  artifactId: string;
  tenantId: string;
  correlationId: string;
  release: Omit<Parameters<typeof createRelease>[0], 'correlationId'>;
  plan: Omit<Parameters<typeof createDeploymentPlan>[0], 'releaseId' | 'artifactId' | 'correlationId'>;
  governance: 'ALLOW' | 'REQUIRES_APPROVAL' | 'DENY';
  approvalValid: boolean;
  securityStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  circuitBreaker: { failureCount: number; threshold: number };
  frozen: boolean;
  provider?: DeploymentAdapter;
  rolloutState: ProgressiveDeliveryState;
  healthInput: Parameters<typeof evaluateHealthGate>[0];
  rollbackSafetyInput: Parameters<typeof evaluateRollbackSafety>[0];

  // Phase 117: rollback target must be explicit.
  // The control plane must never infer a previous release/version.
  previousVersion?: string;

  // Phase 118: canonical rollback target. When executionStore + previousReleaseId
  // are both supplied, the rollback runs through the durable canonical path.
  previousReleaseId?: string;
  executionStore?: ExecutionStore;
  workerId?: string;
}

// Phase 118 - canonical durable rollback path.
//
// Activated only when the caller supplies both an executionStore and a
// previousReleaseId. Phase 117 behaviour is untouched when it is not called.
//
// Chain enforced:
//   explicit target releaseId
//     -> canonical ReleaseRecord
//     -> target artifact + immutable checksum
//     -> durable ExecutionJob (idempotency key)
//     -> ExecutionLease (single owner)
//     -> adapter.rollback(resolved version)
//     -> adapter.verifyRollback(resolved version)
//     -> ROLLED_BACK
//
// Any missing fact or negative result fails closed. Never ROLLED_BACK from
// provider success alone. Never auto-retry a provider call after a crash.
async function executeCanonicalDurableRollback(
  request: AutonomousReleaseDeploymentRequest,
  ctx: any,
): Promise<any> {
  let { execution } = ctx;
  const { release, plan, rollout, halt, auditEvents, evidence, adapter } = ctx;
  const store = request.executionStore!;
  const previousReleaseId = request.previousReleaseId!;
  const workerId = request.workerId ?? 'phase118-worker';

  const audit = (eventType: string, reason: string, decision: string) => {
    auditEvents.push(createDeploymentAuditEvent({
      tenantId: request.tenantId,
      correlationId: request.correlationId,
      eventType, reason, decision,
    }));
  };

  // --- 1. Resolve canonical target release ---
  const targetRelease = store.getRelease(previousReleaseId);
  if (!targetRelease) {
    audit('ROLLBACK_TARGET_UNRESOLVED', 'release not found: ' + previousReleaseId, 'FAILED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED' as const, reason: 'rollback target release not found: ' + previousReleaseId,
      release, plan, execution, rollout, halt, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }
  if (targetRelease.status !== 'DEPLOYED' && targetRelease.status !== 'ROLLED_BACK') {
    audit('ROLLBACK_TARGET_INELIGIBLE', 'target status=' + targetRelease.status, 'FAILED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED' as const, reason: 'target release not eligible: ' + targetRelease.status,
      release, plan, execution, rollout, halt, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }
  const targetArtifactId = targetRelease.artifactId;
  if (!targetArtifactId) {
    audit('ROLLBACK_TARGET_ARTIFACT_MISSING', 'release has no artifact', 'FAILED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED' as const, reason: 'target release has no artifact',
      release, plan, execution, rollout, halt, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }
  const targetArtifact = store.getArtifact(targetArtifactId);
  if (!targetArtifact) {
    audit('ROLLBACK_TARGET_ARTIFACT_MISSING', 'artifact not found: ' + targetArtifactId, 'FAILED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED' as const, reason: 'target artifact not found: ' + targetArtifactId,
      release, plan, execution, rollout, halt, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }
  audit('ROLLBACK_TARGET_RESOLVED',
    'release=' + previousReleaseId + ' artifact=' + targetArtifactId + ' checksum=' + targetArtifact.checksum,
    'PROPOSED');

  // --- 2. Safety gate (Phase 117 preserved) ---
  const safety = evaluateRollbackSafety(request.rollbackSafetyInput);
  if (!safety.allowed) {
    audit('ROLLBACK_VALIDATION_FAILED', safety.reason, 'FAILED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED' as const, reason: safety.reason,
      release, plan, execution, rollout, halt, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }
  audit('ROLLBACK_VALIDATION_PASSED', 'safety ok', 'AUTHORIZED');

  // --- 3. Durable job + idempotency ---
  // Phase 118: keyed on canonical target so repeated calls replay idempotently.
  // releaseId is globally unique; executionId is not stable across recoveries.
  const idempotencyKey = 'rollback:' + previousReleaseId;
  const existing = store.getJobByIdempotencyKey(idempotencyKey);
  let job: ExecutionJob;

  if (existing) {
    if (existing.status === 'SUCCEEDED') {
      audit('ROLLBACK_ALREADY_COMPLETED', 'terminal job exists', 'ROLLED_BACK');
      execution = transitionDeploymentExecution(execution, 'ROLLED_BACK');
      return { status: 'ROLLED_BACK' as const, reason: 'rollback already completed (idempotent)',
        release, plan, execution, rollout, halt, auditEvents, evidence,
        lineage: { releaseId: release.releaseId, nodes: [] } };
    }
    if (existing.status === 'FAILED' || existing.status === 'DEAD_LETTER' || existing.status === 'CANCELLED') {
      audit('ROLLBACK_ALREADY_FAILED', 'terminal failed job exists', 'FAILED');
      execution = transitionDeploymentExecution(execution, 'FAILED');
      return { status: 'FAILED' as const, reason: 'rollback previously failed (idempotent)',
        release, plan, execution, rollout, halt, auditEvents, evidence,
        lineage: { releaseId: release.releaseId, nodes: [] } };
    }
    const active = store.getActiveLeaseForJob(existing.id);
    if (active && active.workerId !== workerId) {
      audit('ROLLBACK_BLOCKED', 'another worker owns rollback job', 'BLOCKED');
      execution = transitionDeploymentExecution(execution, 'FAILED');
      return { status: 'RECOVERY_REQUIRED' as const, reason: 'rollback job held by another worker',
        release, plan, execution, rollout, halt, auditEvents, evidence,
        lineage: { releaseId: release.releaseId, nodes: [] } };
    }
    // Same worker or expired lease. If it was RUNNING, provider state is unknown.
    // Do NOT auto re-call adapter.rollback. Fail closed.
    if (existing.status === 'RUNNING' || existing.status === 'CLAIMED') {
      audit('ROLLBACK_RECOVERY_AMBIGUOUS', 'prior attempt did not complete; state ambiguous', 'RECOVERY_REQUIRED');
      execution = transitionDeploymentExecution(execution, 'FAILED');
      return { status: 'RECOVERY_REQUIRED' as const,
        reason: 'prior rollback attempt did not complete; provider state ambiguous',
        release, plan, execution, rollout, halt, auditEvents, evidence,
        lineage: { releaseId: release.releaseId, nodes: [] } };
    }
    job = existing;
  } else {
    const now = Date.now();
    job = {
      id: 'rollback-job-' + execution.executionId + '-' + now,
      idempotencyKey,
      jobType: 'ROLLBACK',
      payload: { executionId: execution.executionId, previousReleaseId,
                 targetArtifactId, expectedChecksum: targetArtifact.checksum },
      status: 'QUEUED',
      createdAt: now, updatedAt: now,
      cancellationRequested: false, cancellationAcknowledged: false,
    } as ExecutionJob;
    store.createJob(job);
    audit('ROLLBACK_REQUESTED', 'durable rollback job created', 'PROPOSED');
  }

  // --- 4. Lease ---
  const now = Date.now();
  const leaseId = 'lease-' + job.id + '-' + workerId;
  const leaseRes = store.acquireLease({
    leaseId, jobId: job.id, workerId,
    acquiredAt: now, expiresAt: now + 60_000, status: 'ACTIVE',
  });
  if (!leaseRes.acquired) {
    audit('ROLLBACK_BLOCKED', 'lease not acquired', 'BLOCKED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'RECOVERY_REQUIRED' as const, reason: 'rollback lease not acquired',
      release, plan, execution, rollout, halt, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // --- 5. State machine + provider ---
  const rollback = createRollbackExecution(execution.executionId, previousReleaseId);
  let rbExec = transitionRollbackExecution(rollback, 'ROLLBACK_VALIDATING');
  rbExec = transitionRollbackExecution(rbExec, 'ROLLBACK_EXECUTING');

  job.status = 'RUNNING'; job.updatedAt = Date.now(); job.currentLeaseId = leaseId;
  store.updateJob(job);
  const attemptId = 'att-' + job.id + '-' + Date.now();
  store.createAttempt({
    id: attemptId, jobId: job.id, attemptNumber: 1, status: 'RUNNING',
    workerId, leaseId, startedAt: Date.now(), createdAt: Date.now(),
  });
  audit('ROLLBACK_EXECUTION_STARTED', 'invoking provider with version=' + targetRelease.version, 'EXECUTING');

  const rbResult = await adapter.rollback(targetRelease.version);
  if (!rbResult.success) {
    store.updateAttempt({ id: attemptId, jobId: job.id, attemptNumber: 1, status: 'FAILED',
      workerId, leaseId, startedAt: now, completedAt: Date.now(), error: rbResult.reason,
      createdAt: now } as any);
    job.status = 'FAILED'; job.updatedAt = Date.now(); store.updateJob(job);
    rbExec = transitionRollbackExecution(rbExec, 'ROLLBACK_FAILED');
    audit('ROLLBACK_EXECUTION_FAILED', rbResult.reason, 'FAILED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED' as const, reason: rbResult.reason,
      release, plan, execution, rollout, halt, rollback: rbExec, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // --- 6. Independent verification ---
  rbExec = transitionRollbackExecution(rbExec, 'ROLLBACK_VERIFYING');
  audit('ROLLBACK_VERIFICATION_STARTED', 'verifyRollback(' + targetRelease.version + ')', 'VERIFYING');

  if (typeof adapter.verifyRollback !== 'function') {
    store.updateAttempt({ id: attemptId, jobId: job.id, attemptNumber: 1, status: 'FAILED',
      workerId, leaseId, startedAt: now, completedAt: Date.now(),
      error: 'no verifyRollback capability', createdAt: now } as any);
    job.status = 'FAILED'; job.updatedAt = Date.now(); store.updateJob(job);
    rbExec = transitionRollbackExecution(rbExec, 'ROLLBACK_FAILED');
    audit('ROLLBACK_VERIFICATION_FAILED', 'adapter cannot verify', 'FAILED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED' as const, reason: 'rollback verification is unavailable',
      release, plan, execution, rollout, halt, rollback: rbExec, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  const verification = await adapter.verifyRollback(targetRelease.version);
  if (!verification.verified) {
    const reason = (verification.reasons || []).join('; ') || 'verification failed';
    store.updateAttempt({ id: attemptId, jobId: job.id, attemptNumber: 1, status: 'FAILED',
      workerId, leaseId, startedAt: now, completedAt: Date.now(), error: reason, createdAt: now } as any);
    job.status = 'FAILED'; job.updatedAt = Date.now(); store.updateJob(job);
    rbExec = transitionRollbackExecution(rbExec, 'ROLLBACK_FAILED');
    audit('ROLLBACK_VERIFICATION_FAILED', reason, 'FAILED');
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED' as const, reason,
      release, plan, execution, rollout, halt, rollback: rbExec, auditEvents, evidence,
      lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // --- 7. Terminal success ---
  rbExec = transitionRollbackExecution(rbExec, 'ROLLED_BACK');
  store.updateAttempt({ id: attemptId, jobId: job.id, attemptNumber: 1, status: 'SUCCEEDED',
    workerId, leaseId, startedAt: now, completedAt: Date.now(),
    evidence: ['verifyRollback:' + targetRelease.version + ':' + targetArtifact.checksum],
    createdAt: now } as any);
  job.status = 'SUCCEEDED'; job.updatedAt = Date.now(); store.updateJob(job);
  execution = transitionDeploymentExecution(execution, 'ROLLED_BACK');
  audit('ROLLBACK_COMPLETED', 'verified at version=' + targetRelease.version, 'ROLLED_BACK');
  return { status: 'ROLLED_BACK' as const, reason: 'rollback executed and independently verified',
    release, plan, execution, rollout, halt, rollback: rbExec, auditEvents, evidence,
    lineage: { releaseId: release.releaseId, nodes: [] } };
}
export async function orchestrateReleaseDeployment(request: AutonomousReleaseDeploymentRequest) {
  const auditEvents: ReturnType<typeof createDeploymentAuditEvent>[] = [];
  const evidence: ReturnType<typeof createDeploymentEvidence>[] = [];
  const adapter = request.provider ?? unavailableDeploymentAdapter;

  // Release
  const release = createRelease({ ...request.release });

  // Governance/Security/Approval/CircuitBreaker/Freeze
  if (request.governance === 'DENY' || !request.approvalValid || request.securityStatus === 'FAIL' || evaluateDeploymentCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold) === 'OPEN' || request.frozen) {
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DEPLOYMENT_BLOCKED', reason: 'policy gate failed', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'policy gate failed', release, auditEvents, evidence, lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // Deployment plan
  const plan = createDeploymentPlan({ ...request.plan, releaseId: release.releaseId, artifactId: request.artifactId });

  // Execution
  let execution = createDeploymentExecution({ planId: plan.planId });
  execution = transitionDeploymentExecution(execution, 'APPROVAL_PENDING');
  execution = transitionDeploymentExecution(execution, 'APPROVED');
  execution = transitionDeploymentExecution(execution, 'STARTING');
  execution = transitionDeploymentExecution(execution, 'RUNNING');

  // Provider deploy
  const deployResult = await adapter.deploy(request.artifactId, request.release.version);
  if (!deployResult.success) {
    execution = transitionDeploymentExecution(execution, 'FAILED');
    auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DEPLOYMENT_FAILED', reason: deployResult.reason, decision: 'FAILED' }));
    return { status: 'FAILED', reason: deployResult.reason, release, plan, execution, auditEvents, evidence, lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // Progressive rollout
  const rollout = advanceRollout(request.rolloutState);
  if (rollout.action === 'HALT') {
    const halt = createDeploymentHalt(execution.executionId, 'rollout halt');
    execution = transitionDeploymentExecution(execution, 'ROLLING_BACK');
    // Phase 118: canonical durable path when the caller supplies an
    // executionStore and an explicit previousReleaseId. Otherwise the
    // Phase 117 logic below runs unchanged.
    if (request.executionStore && request.previousReleaseId) {
      return await executeCanonicalDurableRollback(request, {
        execution, release, plan, rollout, halt, auditEvents, evidence, adapter,
      });
    }

    // Phase 117: rollback must have an explicit target.
    // Never infer the previous release from the currently deployed release.
    if (!request.previousVersion) {
      auditEvents.push(createDeploymentAuditEvent({
        tenantId: request.tenantId,
        correlationId: request.correlationId,
        eventType: 'ROLLBACK_FAILED',
        reason: 'previous rollback target is not specified',
        decision: 'FAILED'
      }));
      execution = transitionDeploymentExecution(execution, 'FAILED');

      return {
        status: 'FAILED',
        reason: 'previous rollback target is not specified',
        release,
        plan,
        execution,
        rollout,
        halt,
        auditEvents,
        evidence,
        lineage: { releaseId: release.releaseId, nodes: [] }
      };
    }

    const rollback = createRollbackExecution(
      execution.executionId,
      request.previousVersion
    );

    const rollbackSafety = evaluateRollbackSafety(request.rollbackSafetyInput);

    if (!rollbackSafety.allowed) {
      const failedRollback = transitionRollbackExecution(
        rollback,
        'ROLLBACK_FAILED'
      );
      execution = transitionDeploymentExecution(execution, 'FAILED');

      auditEvents.push(createDeploymentAuditEvent({
        tenantId: request.tenantId,
        correlationId: request.correlationId,
        eventType: 'ROLLBACK_FAILED',
        reason: rollbackSafety.reason,
        decision: 'FAILED'
      }));

      return {
        status: 'FAILED',
        reason: rollbackSafety.reason,
        release,
        plan,
        execution,
        rollout,
        halt,
        rollback: failedRollback,
        auditEvents,
        evidence,
        lineage: { releaseId: release.releaseId, nodes: [] }
      };
    }

    let rollbackExec = transitionRollbackExecution(
      rollback,
      'ROLLBACK_VALIDATING'
    );

    rollbackExec = transitionRollbackExecution(
      rollbackExec,
      'ROLLBACK_EXECUTING'
    );

    const rollbackResult = await adapter.rollback(request.previousVersion);

    if (!rollbackResult.success) {
      const failedRollback = transitionRollbackExecution(
        rollbackExec,
        'ROLLBACK_FAILED'
      );
      execution = transitionDeploymentExecution(execution, 'FAILED');

      auditEvents.push(createDeploymentAuditEvent({
        tenantId: request.tenantId,
        correlationId: request.correlationId,
        eventType: 'ROLLBACK_FAILED',
        reason: rollbackResult.reason,
        decision: 'FAILED'
      }));

      return {
        status: 'FAILED',
        reason: rollbackResult.reason,
        release,
        plan,
        execution,
        rollout,
        halt,
        rollback: failedRollback,
        auditEvents,
        evidence,
        lineage: { releaseId: release.releaseId, nodes: [] }
      };
    }

    // A successful rollback command is not proof that the previous
    // version is actually running and healthy.
    rollbackExec = transitionRollbackExecution(
      rollbackExec,
      'ROLLBACK_VERIFYING'
    );

    if (!adapter.verifyRollback) {
      const failedRollback = transitionRollbackExecution(
        rollbackExec,
        'ROLLBACK_FAILED'
      );
      execution = transitionDeploymentExecution(execution, 'FAILED');

      auditEvents.push(createDeploymentAuditEvent({
        tenantId: request.tenantId,
        correlationId: request.correlationId,
        eventType: 'ROLLBACK_FAILED',
        reason: 'rollback verification is unavailable',
        decision: 'FAILED'
      }));

      return {
        status: 'FAILED',
        reason: 'rollback verification is unavailable',
        release,
        plan,
        execution,
        rollout,
        halt,
        rollback: failedRollback,
        auditEvents,
        evidence,
        lineage: { releaseId: release.releaseId, nodes: [] }
      };
    }

    const rollbackVerification = await adapter.verifyRollback(
      request.previousVersion
    );

    if (!rollbackVerification.verified) {
      const reason = rollbackVerification.reasons.join('; ') ||
        'rollback verification failed';

      const failedRollback = transitionRollbackExecution(
        rollbackExec,
        'ROLLBACK_FAILED'
      );
      execution = transitionDeploymentExecution(execution, 'FAILED');

      auditEvents.push(createDeploymentAuditEvent({
        tenantId: request.tenantId,
        correlationId: request.correlationId,
        eventType: 'ROLLBACK_FAILED',
        reason,
        decision: 'FAILED'
      }));

      return {
        status: 'FAILED',
        reason,
        release,
        plan,
        execution,
        rollout,
        halt,
        rollback: failedRollback,
        auditEvents,
        evidence,
        lineage: { releaseId: release.releaseId, nodes: [] }
      };
    }

    // Only an independent positive verification permits ROLLED_BACK.
    const verifiedRollback = transitionRollbackExecution(
      rollbackExec,
      'ROLLED_BACK'
    );
    execution = transitionDeploymentExecution(execution, 'ROLLED_BACK');

    auditEvents.push(createDeploymentAuditEvent({
      tenantId: request.tenantId,
      correlationId: request.correlationId,
      eventType: 'ROLLBACK_COMPLETED',
      reason: 'rollout halt rollback verified',
      decision: 'ROLLED_BACK'
    }));

    return {
      status: 'ROLLED_BACK',
      reason: 'rollout halt rollback verified',
      release,
      plan,
      execution,
      rollout,
      halt,
      rollback: verifiedRollback,
      auditEvents,
      evidence,
      lineage: { releaseId: release.releaseId, nodes: [] }
    };
  }

  // Health gate
  const health = evaluateHealthGate(request.healthInput);
  if (health === 'UNHEALTHY' || health === 'DEGRADED') {
    execution = transitionDeploymentExecution(execution, 'FAILED');
    return { status: 'FAILED', reason: `health ${health}`, release, plan, execution, rollout, health, auditEvents, evidence, lineage: { releaseId: release.releaseId, nodes: [] } };
  }

  // Complete
  execution = transitionDeploymentExecution(execution, 'SUCCEEDED');
  evidence.push(createDeploymentEvidence({ deploymentId: execution.executionId, releaseId: release.releaseId, artifactId: request.artifactId, provider: 'test', strategy: plan.strategy, healthResult: health, rollbackState: 'NONE', finalResult: 'SUCCESS' }));
  auditEvents.push(createDeploymentAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'DEPLOYMENT_SUCCEEDED', reason: 'deployment completed', decision: 'SUCCESS' }));
  const lineage: ReleaseLineage = { releaseId: release.releaseId, nodes: [] };
  addReleaseLineageNode(lineage, { version: 1, releaseId: release.releaseId, artifactId: request.artifactId, deploymentId: execution.executionId, timestamp: new Date().toISOString() });

  return { status: 'COMPLETED', release, plan, execution, rollout, health, evidence, auditEvents, lineage };
}
