import { randomUUID } from 'crypto';
import { ExecutionStore } from './execution-store';
import { ExecutionJob, ExecutionJobStatus } from './execution-models';
import {
  StageExecution,
  StageExecutionPersistencePort,
  StageStatus,
  StageTransitionEvidence,
} from './worker-stage-execution';

const STAGE_JOB_TYPE = 'pipeline.stage';

interface StagePayload {
  kind: 'pipeline.stage';
  executionId: string;
  tenantId: string;
  correlationId: string;
  stageName: string;
  attempt: number;
  /** Domain projection. Job status is authoritative for the machine lifecycle. */
  status: StageStatus;
  executor: string;
  inputFingerprint: string;
  outputFingerprint?: string;
  logsReference?: string;
  artifactReferences: string[];
  failureReason?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  workerId?: string;
  leaseId?: string;
  evidenceRef?: string;
}

function stageToJobStatus(to: StageStatus): ExecutionJobStatus {
  switch (to) {
    case 'PENDING':   return 'QUEUED';
    case 'RUNNING':   return 'RUNNING';
    case 'SUCCEEDED': return 'SUCCEEDED';
    case 'FAILED':    return 'FAILED';
    case 'SKIPPED':   return 'CANCELLED'; // reason preserved in payload
    case 'CANCELLED': return 'CANCELLED';
  }
}

function jobToStageStatus(job: ExecutionJob): StageStatus {
  switch (job.status) {
    case 'QUEUED':                return 'PENDING';
    case 'CLAIMED':
    case 'RUNNING':
    case 'VERIFYING':
    case 'CANCELLATION_REQUESTED': return 'RUNNING';
    case 'SUCCEEDED':              return 'SUCCEEDED';
    case 'FAILED':
    case 'RETRY_SCHEDULED':
    case 'DEAD_LETTER':
    case 'ORPHANED':
    case 'BLOCKED':                return 'FAILED';
    case 'CANCELLED': {
      // Only legitimate divergence: SKIPPED is CANCELLED at the job level.
      const p = job.payload as StagePayload | undefined;
      return p?.status === 'SKIPPED' ? 'SKIPPED' : 'CANCELLED';
    }
  }
}

export class StageExecutionStoreAdapter implements StageExecutionPersistencePort {
  constructor(private readonly store: ExecutionStore) {}

  async findByKey(idempotencyKey: string): Promise<StageExecution | null> {
    const job = this.store.getJobByIdempotencyKey(idempotencyKey);
    return job ? this.toStage(job) : null;
  }

  async findById(stageExecutionId: string): Promise<StageExecution | null> {
    const job = this.store.getJob(stageExecutionId);
    return job ? this.toStage(job) : null;
  }

  async insertIfAbsent(stage: StageExecution): Promise<StageExecution> {
    const existing = this.store.getJobByIdempotencyKey(stage.idempotencyKey);
    if (existing) return this.toStage(existing);

    const now = Date.parse(stage.createdAt);
    const job: ExecutionJob = {
      id: stage.stageExecutionId,
      idempotencyKey: stage.idempotencyKey,
      jobType: STAGE_JOB_TYPE,
      payload: this.toPayload(stage),
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
      cancellationRequested: false,
      cancellationAcknowledged: false,
    };
    try {
      this.store.createJob(job);
      return stage;
    } catch (err: any) {
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err?.message)) {
        const race = this.store.getJobByIdempotencyKey(stage.idempotencyKey);
        if (!race) throw err;
        return this.toStage(race);
      }
      throw err;
    }
  }

  async transitionWithLease(args: {
    stageExecutionId: string;
    from: StageStatus;
    to: StageStatus;
    workerId: string;
    leaseId: string;
    patch?: Partial<StageExecution>;
    evidence: StageTransitionEvidence;
  }): Promise<StageExecution> {
    const before = this.store.getJob(args.stageExecutionId);
    if (!before) throw new Error('Unknown stage ' + args.stageExecutionId);

    const beforeDomain = this.toStage(before);
    if (beforeDomain.status !== args.from) {
      // Idempotent completion: same terminal target already reached.
      if (beforeDomain.status === args.to) return beforeDomain;
      throw new Error(
        'Stage ' + args.stageExecutionId + ' domain status ' + beforeDomain.status + ' != expected ' + args.from
      );
    }

    const nextDomain: StageExecution = { ...beforeDomain, ...args.patch, status: args.to };
    const nextJobStatus = stageToJobStatus(args.to);

    const result = this.store.transitionExecution({
      jobId: args.stageExecutionId,
      actor: 'worker',
      expectedStatus: before.status,
      newStatus: nextJobStatus,
      workerId: args.workerId,
      leaseId: args.leaseId,
      reason: args.evidence.reason,
      patch: { payload: this.toPayload(nextDomain) },
    });

    if (!result.ok) {
      if (result.reason === 'WORKER_OWNERSHIP_LOST') {
        this.store.writeOwnershipObligation({
          jobId: args.stageExecutionId,
          leaseId: args.leaseId,
          workerId: args.workerId,
          reason: 'stage transition ' + args.from + '->' + args.to + ' attempted after ownership loss',
        });
      }
      throw new Error('stage transition failed: ' + result.reason);
    }

    this.store.addEvent({
      eventId: randomUUID(),
      jobId: args.stageExecutionId,
      eventType: 'STAGE_TRANSITION',
      payload: args.evidence,
      createdAt: Date.parse(args.evidence.at),
    });

    const after = this.store.getJob(args.stageExecutionId);
    if (!after) throw new Error('stage vanished after transition: ' + args.stageExecutionId);
    return this.toStage(after);
  }

  private toPayload(s: StageExecution): StagePayload {
    return {
      kind: 'pipeline.stage',
      executionId: s.executionId,
      tenantId: s.tenantId,
      correlationId: s.correlationId,
      stageName: s.stageName,
      attempt: s.attempt,
      status: s.status,
      executor: s.executor,
      inputFingerprint: s.inputFingerprint,
      outputFingerprint: s.outputFingerprint,
      logsReference: s.logsReference,
      artifactReferences: s.artifactReferences,
      failureReason: s.failureReason,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      workerId: s.workerId,
      leaseId: s.leaseId,
      evidenceRef: s.evidenceRef,
    };
  }

  private toStage(job: ExecutionJob): StageExecution {
    const p = job.payload as StagePayload | undefined;
    if (!p || p.kind !== 'pipeline.stage') {
      throw new Error('job ' + job.id + ' is not a pipeline.stage');
    }
    return {
      stageExecutionId: job.id,
      executionId: p.executionId,
      tenantId: p.tenantId,
      correlationId: p.correlationId,
      stageName: p.stageName,
      attempt: p.attempt,
      status: jobToStageStatus(job), // durable status wins over projection
      executor: p.executor,
      inputFingerprint: p.inputFingerprint,
      outputFingerprint: p.outputFingerprint,
      logsReference: p.logsReference,
      artifactReferences: p.artifactReferences ?? [],
      failureReason: p.failureReason,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      durationMs: p.durationMs,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      idempotencyKey: job.idempotencyKey,
      workerId: p.workerId,
      leaseId: p.leaseId,
      evidenceRef: p.evidenceRef,
    };
  }
}