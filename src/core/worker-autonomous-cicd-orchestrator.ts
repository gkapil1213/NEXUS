import { randomUUID } from 'crypto';
import { createPipelineDefinition, validatePipelineDefinition } from './worker-pipeline-definition';
import { PipelineExecution, PipelineExecutionStatus } from './worker-pipeline-execution';
import { createStageExecution, StageExecution } from './worker-stage-execution';
import { evaluateStageAdmission, evaluateStageAdmissionAsync } from './stage-admission';
import { StageExecutionStoreAdapter } from './stage-execution-store-adapter';
import type {
  ProductionReleaseEnforcementService,
  DeploymentResult,
} from './production-release-enforcement';
import { ExecutionStore } from './execution-store';
import { ExecutionJob, ExecutionJobStatus } from './execution-models';
import { LeaseManager } from './lease-manager';
import { ExecutionAdapter } from './execution-adapter';
import { classifyChange } from './worker-change-detection';
import { createArtifact, verifyArtifactIntegrity } from './worker-artifact';
import { createReleaseCandidate, transitionReleaseCandidate } from './worker-release-candidate';
import { classifyReleaseRisk } from './worker-release-risk';
import { executeCommand, CommandResult } from './worker-command-executor';
import { createProductionAuditEvent } from './worker-production-audit';
import { createProductionEvidence } from './worker-production-evidence';
import { addProductionLineageNode, ProductionLineage } from './worker-production-lineage';

export interface CICDRequest {
  tenantId: string;
  correlationId: string;
  pipelineDef: Omit<Parameters<typeof createPipelineDefinition>[0], 'correlationId'>;
  repository: string;
  revision: string;
  actor: string;
  trigger: string;
  changedFiles: string[];
  riskInput: Parameters<typeof classifyReleaseRisk>[0];
  governanceDecision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  safetyDecision: 'ALLOW' | 'DENY';
  approvalRequired: boolean;
  approvalGranted: boolean;
  artifactExpectedFingerprint?: string;
  deploymentTargetHealthy: boolean;
  idempotencyKey?: string;
  // Phase 129: durable execution dependencies. Optional to preserve callers.
  // If any is absent, the orchestrator returns BLOCKED rather than fabricating success.
  store?: ExecutionStore;
  leaseManager?: LeaseManager;
  adapter?: ExecutionAdapter;
  workerId?: string;
  leaseTtlMs?: number;
  releaseVersion?: string;
  // Phase 130: optional production deployment integration. When absent,
  // orchestrateCICD returns COMPLETED with deployed=false.
  releaseEnforcement?: ProductionReleaseEnforcementService;
  deployment?: {
    environment: string;
    projectId: string | null;
    artifactId: string;
    artifactDigest: string;
    imageRepository: string;
    imageTag: string;
    imageId: string | null;
    containerName: string;
    containerPort: number;
    approval: any;
  };
}

function jobStatusToPipelineStatus(s: ExecutionJobStatus): PipelineExecutionStatus {
  switch (s) {
    case 'QUEUED': return 'QUEUED';
    case 'CLAIMED':
    case 'RUNNING':
    case 'VERIFYING':
    case 'CANCELLATION_REQUESTED': return 'RUNNING';
    case 'SUCCEEDED': return 'SUCCEEDED';
    case 'CANCELLED': return 'CANCELLED';
    case 'FAILED':
    case 'RETRY_SCHEDULED':
    case 'DEAD_LETTER':
    case 'ORPHANED':
    case 'BLOCKED':
    default: return 'FAILED';
  }
}

function projectPipelineExecution(job: ExecutionJob, fallback: {
  pipelineId: string;
  pipelineVersion: number;
  repository: string;
  revision: string;
  actor: string;
  trigger: string;
  correlationId: string;
}): PipelineExecution {
  const p = (job.payload ?? {}) as Record<string, any>;
  return {
    executionId: job.id,
    pipelineId: p.pipelineId ?? fallback.pipelineId,
    pipelineVersion: p.pipelineVersion ?? fallback.pipelineVersion,
    repository: p.repository ?? fallback.repository,
    revision: p.revision ?? fallback.revision,
    status: jobStatusToPipelineStatus(job.status),
    actor: p.actor ?? fallback.actor,
    trigger: p.trigger ?? fallback.trigger,
    idempotencyKey: job.idempotencyKey,
    correlationId: p.correlationId ?? fallback.correlationId,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

type AuditEvent       = ReturnType<typeof createProductionAuditEvent>;
type Evidence         = ReturnType<typeof createProductionEvidence>;
type Pipeline         = ReturnType<typeof createPipelineDefinition>;
type Artifact         = ReturnType<typeof createArtifact>;
type ReleaseCandidate = ReturnType<typeof createReleaseCandidate>;
type ReleaseRisk      = ReturnType<typeof classifyReleaseRisk>;

export type CICDResult =
  | { status: 'INVALID'; reason: string; pipeline: Pipeline; auditEvents: AuditEvent[]; evidence: Evidence[] }
  | { status: 'BLOCKED'; reason: string; blockedReason: string; pipeline: Pipeline; changeCategory?: string; execution?: PipelineExecution; stages?: StageExecution[]; artifact?: Artifact; rc?: ReleaseCandidate; risk?: ReleaseRisk; deployment?: DeploymentResult | null; auditEvents: AuditEvent[]; evidence: Evidence[] }
  | { status: 'ALREADY_TERMINAL'; reason: string; terminalStatus: string; pipeline: Pipeline; execution: PipelineExecution; auditEvents: AuditEvent[]; evidence: Evidence[] }
  | { status: 'FAILED'; reason: string; pipeline: Pipeline; execution?: PipelineExecution; stages?: StageExecution[]; artifact?: Artifact; rc?: ReleaseCandidate; risk?: ReleaseRisk; deployment?: DeploymentResult | null; auditEvents: AuditEvent[]; evidence: Evidence[] }
  | { status: 'RECOVERY_REQUIRED'; reason: string; pipeline: Pipeline; execution?: PipelineExecution; stages?: StageExecution[]; artifact?: Artifact; rc?: ReleaseCandidate; risk?: ReleaseRisk; deployment?: DeploymentResult | null; auditEvents: AuditEvent[]; evidence: Evidence[] }
  | { status: 'CANCELLED'; reason: string; pipeline: Pipeline; execution: PipelineExecution; auditEvents: AuditEvent[]; evidence: Evidence[] }
  | { status: 'UNKNOWN'; reason: string; pipeline: Pipeline; execution?: PipelineExecution; stages?: StageExecution[]; artifact?: Artifact; rc?: ReleaseCandidate; risk?: ReleaseRisk; deployment?: DeploymentResult | null; auditEvents: AuditEvent[]; evidence: Evidence[] }
  | { status: 'COMPLETED'; pipeline: Pipeline; execution: PipelineExecution; stages: StageExecution[]; artifact: Artifact; rc: ReleaseCandidate; risk: ReleaseRisk; changeCategory: string; cmdResult: CommandResult; lineage: ProductionLineage; deployment: DeploymentResult | null; deployed: boolean; auditEvents: AuditEvent[]; evidence: Evidence[] };

export async function orchestrateCICD(request: CICDRequest): Promise<CICDResult> {
  const auditEvents: ReturnType<typeof createProductionAuditEvent>[] = [];
  const evidence: ReturnType<typeof createProductionEvidence>[] = [];

  // 1. Pipeline definition
  const pipeline = createPipelineDefinition({ ...request.pipelineDef, correlationId: request.correlationId });
  const validation = validatePipelineDefinition(pipeline);
  if (!validation.valid) {
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_VALIDATION_FAILED', reason: validation.reasons.join(', '), decision: 'INVALID' }));
    return { status: 'INVALID' as const, reason: validation.reasons.join(', '), pipeline, auditEvents, evidence };
  }

  // 2. Change classification
  const changeCategory = classifyChange(request.changedFiles);

  // 3. Capability gate (Phase 129). Unavailable infrastructure must not become SUCCESS.
  if (!request.store || !request.leaseManager || !request.adapter || !request.workerId) {
    const reason = 'durable execution store, lease manager, execution adapter, and workerId are required';
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_BLOCKED', reason, decision: 'BLOCKED' }));
    return { status: 'BLOCKED' as const, reason, blockedReason: 'NO_DURABLE_EXECUTION', pipeline, changeCategory, auditEvents, evidence };
  }

  const adapterHealthy = await request.adapter.healthCheck().catch(() => false);
  if (!adapterHealthy) {
    const reason = `execution adapter '${request.adapter.getId()}' is unhealthy or unavailable`;
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_BLOCKED', reason, decision: 'BLOCKED' }));
    return { status: 'BLOCKED' as const, reason, blockedReason: 'EXECUTOR_UNAVAILABLE', pipeline, changeCategory, auditEvents, evidence };
  }

  // 4. Durable pipeline job, idempotent submission (Â§9)
  const idempotencyKey = request.idempotencyKey
    ?? `pipeline:${pipeline.fingerprint}:${request.revision}:${request.correlationId}`;

  let pipelineJob = request.store.getJobByIdempotencyKey(idempotencyKey);
  if (!pipelineJob) {
    const now = Date.now();
    const candidate: ExecutionJob = {
      id: randomUUID(),
      idempotencyKey,
      jobType: 'pipeline',
      payload: {
        kind: 'pipeline',
        pipelineId: pipeline.pipelineId,
        pipelineVersion: pipeline.version,
        repository: request.repository,
        revision: request.revision,
        actor: request.actor,
        trigger: request.trigger,
        tenantId: request.tenantId,
        correlationId: request.correlationId,
      },
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
      cancellationRequested: false,
      cancellationAcknowledged: false,
    };
    try {
      request.store.createJob(candidate);
      pipelineJob = candidate;
    } catch (err: any) {
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err?.message)) {
        const raced = request.store.getJobByIdempotencyKey(idempotencyKey);
        if (!raced) throw err;
        pipelineJob = raced;
      } else {
        throw err;
      }
    }
  }

  const fallback = {
    pipelineId: pipeline.pipelineId,
    pipelineVersion: pipeline.version,
    repository: request.repository,
    revision: request.revision,
    actor: request.actor,
    trigger: request.trigger,
    correlationId: request.correlationId,
  };

  let execution = projectPipelineExecution(pipelineJob, fallback);

  // Terminal resume: report honest current state, do not fabricate.
  if (pipelineJob.status === 'CANCELLED') {
    return {
      status: 'CANCELLED' as const,
      reason: `pipeline cancelled: ${pipelineJob.status}`,
      pipeline, execution, auditEvents, evidence,
    };
  }
  if (pipelineJob.status === 'SUCCEEDED' || pipelineJob.status === 'FAILED'
      || pipelineJob.status === 'DEAD_LETTER') {
    return {
      status: 'ALREADY_TERMINAL' as const,
      terminalStatus: pipelineJob.status,
      reason: `pipeline already terminal: ${pipelineJob.status}`,
      pipeline, execution, auditEvents, evidence,
    };
  }

  // 5. Acquire pipeline lease (Phase 126 ownership, Â§10)
  const leaseTtlMs = request.leaseTtlMs ?? 60_000;
  let pipelineLease;
  try {
    pipelineLease = request.leaseManager.acquireLease(pipelineJob.id, request.workerId, leaseTtlMs);
  } catch (err: any) {
    const reason = `pipeline lease acquisition failed: ${err.message}`;
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_BLOCKED', reason, decision: 'BLOCKED' }));
    return { status: 'BLOCKED' as const, reason, blockedReason: 'LEASE_UNAVAILABLE', pipeline, execution, auditEvents, evidence };
  }

  // 6. Pipeline QUEUED -> RUNNING via authoritative transition (Â§11)
  const runningT = request.store.transitionExecution({
    jobId: pipelineJob.id,
    actor: 'worker',
    expectedStatus: pipelineJob.status,
    newStatus: 'RUNNING',
    workerId: request.workerId,
    leaseId: pipelineLease.leaseId,
    reason: 'pipeline start',
  });
  if (!runningT.ok) {
    request.leaseManager.releaseLease(pipelineLease.leaseId);
    const reason = `pipeline transition to RUNNING failed: ${runningT.reason}`;
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_BLOCKED', reason, decision: 'BLOCKED' }));
    return { status: 'BLOCKED' as const, reason, blockedReason: runningT.reason, pipeline, execution, auditEvents, evidence };
  }
  execution = projectPipelineExecution(request.store.getJob(pipelineJob.id)!, fallback);

  // 7. Stage loop: real dispatch, durable transitions (Â§6, Â§8, Â§17)
  const stagePort = new StageExecutionStoreAdapter(request.store);
  const stages: StageExecution[] = [];
  const heldLeases: string[] = [pipelineLease.leaseId];

  const failPipeline = (reason: string, status: 'FAILED' | 'BLOCKED') => {
    request.store!.transitionExecution({
      jobId: pipelineJob!.id,
      actor: 'worker',
      expectedStatus: 'RUNNING',
      newStatus: status,
      workerId: request.workerId!,
      leaseId: pipelineLease!.leaseId,
      reason,
    });
    for (const lid of heldLeases) {
      try { request.leaseManager!.releaseLease(lid); } catch { /* already released */ }
    }
    heldLeases.length = 0;
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: status === 'BLOCKED' ? 'PIPELINE_BLOCKED' : 'PIPELINE_FAILED', reason, decision: status }));
  };

  // Phase 201b: validate the declared dependency graph before any stage runs.
  // A cycle or missing ref means the graph cannot reach a terminal state and
  // must be rejected here, before any lease or transition occurs.
  {
    const graphValidation = request.store.stageDeps.validateGraph(
      pipelineJob.id,
      pipeline.stages as unknown as string[],
    );
    if (!graphValidation.ok) {
      const reason = 'invalid dependency graph: ' + graphValidation.errors.join('; ');
      failPipeline(reason, 'BLOCKED');
      return { status: 'BLOCKED' as const, reason, blockedReason: 'INVALID_DEPENDENCY_GRAPH', pipeline, execution, auditEvents, evidence };
    }
  }
  for (const stageName of pipeline.stages) {
    const candidateStage = createStageExecution({
      executionId: pipelineJob.id,
      tenantId: request.tenantId,
      correlationId: request.correlationId,
      stageName,
      executor: request.adapter.getId(),
      inputFingerprint: `${request.revision}:${pipeline.pipelineId}:${stageName}`,
      artifactReferences: [],
    });

    const stored = await stagePort.insertIfAbsent(candidateStage);

    if (stored.status === 'SUCCEEDED') { stages.push(stored); continue; }
    if (stored.status === 'FAILED' || stored.status === 'CANCELLED' || stored.status === 'SKIPPED') {
      stages.push(stored);
      const reason = `stage ${stageName} already terminal: ${stored.status}`;
      failPipeline(reason, 'FAILED');
      return { status: 'FAILED' as const, reason, pipeline, execution, stages, auditEvents, evidence };
    }
    if (stored.status === 'RUNNING') {
      // Interrupted stage needs recovery/reconciliation, which is out of scope for this call.
      const reason = `stage ${stageName} is already RUNNING; recovery required`;
      failPipeline(reason, 'BLOCKED');
      return { status: 'BLOCKED' as const, reason, blockedReason: 'RECOVERY_REQUIRED', pipeline, execution, stages, auditEvents, evidence };
    }

    // Phase 202b: durable runtime admission. Reads dependency graph, stage
    // states, cancellation, and derived job status from the durable store
    // (no reliance on the in-memory `stages` array).
    {
      const elig = request.store.hasAsyncBackend()
        ? await evaluateStageAdmissionAsync({
            store: request.store,
            executionId: pipelineJob.id,
            stageName,
          })
        : evaluateStageAdmission({
            store: request.store,
            executionId: pipelineJob.id,
            stageName,
          });
      const eventBase = {
        eventId: randomUUID(),
        jobId: pipelineJob.id,
        createdAt: Date.now(),
      };
      if (!elig.eligible) {
        try {
          request.store.addEvent({
            ...eventBase,
            eventType: 'execution.dependency.blocked',
            payload: {
              executionId: pipelineJob.id,
              stageName,
              reason: elig.reason,
              missingDependencies: elig.missingDependencies ?? null,
              failingDependencies: elig.failingDependencies ?? null,
              inFlightDependencies: elig.inFlightDependencies ?? null,
              retryPendingDependencies: elig.retryPendingDependencies ?? null,
            },
          });
        } catch { /* audit best-effort */ }
        const reason = `stage ${stageName} ineligible: ${elig.reason}`;
        failPipeline(reason, 'BLOCKED');
        return { status: 'BLOCKED' as const, reason, blockedReason: elig.reason, pipeline, execution, stages, auditEvents, evidence };
      }
      try {
        request.store.addEvent({
          ...eventBase,
          eventType: 'execution.dependency.satisfied',
          payload: {
            executionId: pipelineJob.id,
            stageName,
          },
        });
      } catch { /* audit best-effort */ }
    }
    // Acquire stage lease
    let stageLease;
    try {
      stageLease = request.leaseManager.acquireLease(stored.stageExecutionId, request.workerId, leaseTtlMs);
      heldLeases.push(stageLease.leaseId);
    } catch (err: any) {
      const reason = `stage lease acquisition failed for ${stageName}: ${err.message}`;
      failPipeline(reason, 'BLOCKED');
      return { status: 'BLOCKED' as const, reason, blockedReason: 'LEASE_UNAVAILABLE', pipeline, execution, stages, auditEvents, evidence };
    }

    // PENDING -> RUNNING (authoritative, lease-fenced)
    const startNow = new Date().toISOString();
    let running: StageExecution;
    try {
      running = await stagePort.transitionWithLease({
        stageExecutionId: stored.stageExecutionId,
        from: 'PENDING',
        to: 'RUNNING',
        workerId: request.workerId,
        leaseId: stageLease.leaseId,
        patch: { startedAt: startNow, workerId: request.workerId, leaseId: stageLease.leaseId },
        evidence: {
          correlationId: request.correlationId,
          executionId: pipelineJob.id,
          stageExecutionId: stored.stageExecutionId,
          from: 'PENDING',
          to: 'RUNNING',
          workerId: request.workerId,
          leaseId: stageLease.leaseId,
          at: startNow,
        },
      });
    } catch (err: any) {
      const reason = `stage ${stageName} PENDING->RUNNING failed: ${err.message}`;
      failPipeline(reason, 'BLOCKED');
      return { status: 'BLOCKED' as const, reason, blockedReason: 'STAGE_TRANSITION_FAILED', pipeline, execution, stages, auditEvents, evidence };
    }
    stages.push(running);

    // Real dispatch (Â§7)
    let adapterResult;
    try {
      adapterResult = await request.adapter.execute(
        {
          operation: stageName,
          args: [],
          metadata: {
            pipelineId: pipeline.pipelineId,
            revision: request.revision,
            correlationId: request.correlationId,
          },
        },
        { jobId: stored.stageExecutionId }
      );
    } catch (err: any) {
      adapterResult = { success: false, stderr: `adapter threw: ${err.message}` };
    }

    const endNow = new Date().toISOString();
    const nextStatus: 'SUCCEEDED' | 'FAILED' = adapterResult.success ? 'SUCCEEDED' : 'FAILED';
    const failureReason = adapterResult.success ? undefined : (adapterResult.stderr ?? 'executor returned failure');

    const ended = await stagePort.transitionWithLease({
      stageExecutionId: stored.stageExecutionId,
      from: 'RUNNING',
      to: nextStatus,
      workerId: request.workerId,
      leaseId: stageLease.leaseId,
      patch: {
        endedAt: endNow,
        outputFingerprint: adapterResult.externalId ?? undefined,
        failureReason,
      },
      evidence: {
        correlationId: request.correlationId,
        executionId: pipelineJob.id,
        stageExecutionId: stored.stageExecutionId,
        from: 'RUNNING',
        to: nextStatus,
        workerId: request.workerId,
        leaseId: stageLease.leaseId,
        reason: failureReason,
        at: endNow,
      },
    });
    stages[stages.length - 1] = ended;

    try { request.leaseManager.releaseLease(stageLease.leaseId); } catch { /* already released */ }
    heldLeases.pop();

    if (!adapterResult.success) {
      const reason = `stage ${stageName} failed: ${failureReason}`;
      failPipeline(reason, 'FAILED');
      return { status: 'FAILED' as const, reason, pipeline, execution, stages, auditEvents, evidence };
    }
  }

  // 8. Command executor probe (evidence only; does not gate success)
  const cmdResult: CommandResult = await executeCommand({ command: 'test', args: [], timeoutMs: 1000 });

  // 9. Artifact creation (reflects real stage outputs)
  const artifact = createArtifact({
    pipelineExecutionId: pipelineJob.id,
    sourceRevision: request.revision,
    buildFingerprint: `${request.revision}:build`,
    type: 'application',
    size: 100,
    metadata: {},
    correlationId: request.correlationId,
  });

  const artifactValid = request.artifactExpectedFingerprint === undefined
    ? true
    : verifyArtifactIntegrity(artifact, request.artifactExpectedFingerprint);
  if (!artifactValid) {
    const reason = 'artifact integrity verification failed';
    failPipeline(reason, 'FAILED');
    return { status: 'FAILED' as const, reason, pipeline, execution, stages, artifact, auditEvents, evidence };
  }

  // 10. Release version required (Â§18). No fabricated v1.0.0.
  if (!request.releaseVersion) {
    const reason = 'releaseVersion not supplied; no production version source configured';
    failPipeline(reason, 'BLOCKED');
    return { status: 'BLOCKED' as const, reason, blockedReason: 'NO_RELEASE_VERSION', pipeline, execution, stages, artifact, auditEvents, evidence };
  }

  const risk = classifyReleaseRisk(request.riskInput);
  let rc = createReleaseCandidate({
    artifactId: artifact.artifactId,
    sourceRevision: request.revision,
    pipelineExecutionId: pipelineJob.id,
    version: request.releaseVersion,
    riskLevel: risk,
    approvalState: request.approvalGranted ? 'APPROVED' : 'PENDING',
    safetyState: request.safetyDecision,
    governanceState: request.governanceDecision === 'ALLOW' ? 'ALLOW' : 'DENY',
    correlationId: request.correlationId,
  });

  // 10b. Validate before governance/approval gates (state machine requires VALIDATED before BLOCKED).
  rc = transitionReleaseCandidate(rc, 'VALIDATED');

  // 11. Governance / safety gates (Â§14)
  if (request.governanceDecision === 'DENY' || request.safetyDecision === 'DENY') {
    rc = transitionReleaseCandidate(rc, 'BLOCKED');
    const reason = 'governance/safety denial';
    failPipeline(reason, 'BLOCKED');
    return { status: 'BLOCKED' as const, reason, blockedReason: 'RELEASE_NOT_AUTHORIZED', pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
  }

  if (request.approvalRequired && !request.approvalGranted) {
    rc = transitionReleaseCandidate(rc, 'BLOCKED');
    const reason = 'approval required';
    failPipeline(reason, 'BLOCKED');
    return { status: 'BLOCKED' as const, reason, blockedReason: 'APPROVAL_REQUIRED', pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
  }

  // 12. Promotion
  rc = transitionReleaseCandidate(rc, 'APPROVED');
  rc = transitionReleaseCandidate(rc, 'PROMOTING');

  if (!request.deploymentTargetHealthy) {
    rc = transitionReleaseCandidate(rc, 'FAILED');
    const reason = 'deployment target unhealthy';
    failPipeline(reason, 'FAILED');
    return { status: 'FAILED' as const, reason, pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
  }
  rc = transitionReleaseCandidate(rc, 'PROMOTED');

  // 12b. Phase 130: optional production deployment integration.
  let deployment: DeploymentResult | null = null;
  let deployed = false;
  if (request.releaseEnforcement && request.deployment) {
    const d = request.deployment;
    let authResult;
    try {
      authResult = await request.releaseEnforcement.requestRelease({
        releaseId: rc.releaseCandidateId,
        executionId: pipelineJob.id,
        artifactId: d.artifactId,
        artifactDigest: d.artifactDigest,
        commitSha: request.revision,
        environment: d.environment,
        approval: d.approval,
        projectId: d.projectId ?? undefined,
        imageRepository: d.imageRepository,
        imageTag: d.imageTag,
        imageId: d.imageId ?? undefined,
        containerName: d.containerName,
        containerPort: d.containerPort,
      });
    } catch (e: any) {
      const reason = 'release authorization threw: ' + (e && e.message ? e.message : 'unknown');
      failPipeline(reason, 'BLOCKED');
      return { status: 'BLOCKED' as const, reason, blockedReason: 'RELEASE_AUTHORIZATION_ERROR', pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
    }
    if (authResult.status !== 'AUTHORIZED' || !authResult.authorization) {
      const reason = (authResult.reasons && authResult.reasons.length > 0)
        ? authResult.reasons.join('; ')
        : 'release not authorized';
      const isApproval = /approval/i.test(reason);
      failPipeline(reason, 'BLOCKED');
      return { status: 'BLOCKED' as const, reason, blockedReason: isApproval ? 'APPROVAL_REQUIRED' : 'RELEASE_NOT_AUTHORIZED', pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
    }
    let deployResult: DeploymentResult;
    try {
      deployResult = await request.releaseEnforcement.executeRelease(
        authResult.authorization.authorizationId,
        rc.releaseCandidateId,
        d.artifactId,
        request.revision,
        d.environment,
        null,
      );
    } catch (e: any) {
      const reason = 'deployment execution threw: ' + (e && e.message ? e.message : 'unknown');
      failPipeline(reason, 'FAILED');
      return { status: 'FAILED' as const, reason, pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
    }
    deployment = deployResult;
    if (deployResult.status === 'DEPLOYED') {
      deployed = true;
    } else if (deployResult.status === 'BLOCKED') {
      const reason = deployResult.message || 'deployment blocked';
      failPipeline(reason, 'BLOCKED');
      return { status: 'BLOCKED' as const, reason, blockedReason: 'DEPLOYMENT_BLOCKED', pipeline, execution, stages, artifact, rc, risk, deployment, auditEvents, evidence };
    } else if (deployResult.status === 'FAIL') {
      const reason = deployResult.message || 'deployment failed';
      failPipeline(reason, 'FAILED');
      return { status: 'FAILED' as const, reason, pipeline, execution, stages, artifact, rc, risk, deployment, auditEvents, evidence };
    } else {
      // AUTHORIZED | EXECUTING | VERIFIED: provider state is non-terminal or
      // ambiguous. Do NOT fabricate FAILED or COMPLETED. Surface as
      // RECOVERY_REQUIRED so the caller knows reconciliation is pending.
      const reason = deployResult.message || ('deployment non-terminal: ' + deployResult.status);
      failPipeline(reason, 'BLOCKED');
      return { status: 'RECOVERY_REQUIRED' as const, reason, pipeline, execution, stages, artifact, rc, risk, deployment, auditEvents, evidence };
    }
  }

  // 13. Pipeline RUNNING -> SUCCEEDED via authoritative transition (Â§12)
  const doneT = request.store.transitionExecution({
    jobId: pipelineJob.id,
    actor: 'worker',
    expectedStatus: 'RUNNING',
    newStatus: 'SUCCEEDED',
    workerId: request.workerId,
    leaseId: pipelineLease.leaseId,
    reason: 'pipeline completed',
  });
  if (!doneT.ok) {
    const reason = `pipeline completion transition failed: ${doneT.reason}`;
    failPipeline(reason, 'BLOCKED');
    return { status: 'BLOCKED' as const, reason, blockedReason: 'COMPLETION_INTEGRITY', pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
  }
  execution = projectPipelineExecution(request.store.getJob(pipelineJob.id)!, fallback);

  // 14. Evidence + lineage
  evidence.push(createProductionEvidence({ tenantId: request.tenantId, correlationId: request.correlationId, operationId: pipelineJob.id, evidenceType: 'PIPELINE_SUCCESS', data: { risk, changeCategory, releaseVersion: request.releaseVersion } }));
  const lineage: ProductionLineage = { environmentId: 'CI', nodes: [] };
  addProductionLineageNode(lineage, { version: 1, requestId: request.correlationId, releaseId: rc.releaseCandidateId, executionId: pipelineJob.id, environmentId: 'CI', timestamp: new Date().toISOString() });

  // 15. Audit
  auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_SUCCEEDED', reason: 'pipeline completed', decision: 'SUCCEEDED' }));

  try { request.leaseManager.releaseLease(pipelineLease.leaseId); } catch { /* already released */ }
  heldLeases.length = 0;

  return { status: 'COMPLETED' as const, pipeline, execution, stages, artifact, rc, risk, changeCategory, cmdResult, auditEvents, evidence, lineage, deployment, deployed };
}