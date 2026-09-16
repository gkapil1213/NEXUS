import { randomUUID } from 'crypto';
import { ExecutionStore } from './execution-store';
import { ExecutionJob, ExecutionJobStatus } from './execution-models';

export type PipelineExecutionStatus = 'QUEUED' | 'RUNNING' | 'PAUSED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

export interface PipelineExecution {
  executionId: string;
  pipelineId: string;
  pipelineVersion: number;
  repository: string;
  revision: string;
  status: PipelineExecutionStatus;
  actor: string;
  trigger: string;
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

const VALID_TRANSITIONS: Record<PipelineExecutionStatus, PipelineExecutionStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

/**
 * PROJECTION ONLY. Returns an in-memory object. On the production path,
 * use submitPipelineExecution (below) to obtain a durable execution id.
 */
export function createPipelineExecution(
  input: Omit<PipelineExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): PipelineExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.pipelineId}:${input.pipelineVersion}:${input.revision}:${input.correlationId}`;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'QUEUED', createdAt: now, updatedAt: now, idempotencyKey };
}

/**
 * PROJECTION ONLY. Pure in-memory transition. Authoritative transitions
 * go through ExecutionStore.transitionExecution under a live lease.
 */
export function transitionPipelineExecution(execution: PipelineExecution, next: PipelineExecutionStatus): PipelineExecution {
  if (!VALID_TRANSITIONS[execution.status].includes(next)) {
    throw new Error(`Illegal pipeline transition from ${execution.status} to ${next}`);
  }
  return { ...execution, status: next, updatedAt: new Date().toISOString() };
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

export interface SubmitPipelineInput {
  tenantId: string;
  pipelineId: string;
  pipelineVersion: number;
  repository: string;
  revision: string;
  actor: string;
  trigger: string;
  correlationId: string;
  idempotencyKey?: string;
}

export interface SubmitPipelineResult {
  execution: PipelineExecution;
  job: ExecutionJob;
  created: boolean;
}

export function projectPipelineExecution(job: ExecutionJob): PipelineExecution {
  const p = (job.payload ?? {}) as Record<string, any>;
  return {
    executionId: job.id,
    pipelineId: p.pipelineId ?? 'unknown',
    pipelineVersion: p.pipelineVersion ?? 0,
    repository: p.repository ?? 'unknown',
    revision: p.revision ?? 'unknown',
    status: jobStatusToPipelineStatus(job.status),
    actor: p.actor ?? 'unknown',
    trigger: p.trigger ?? 'unknown',
    idempotencyKey: job.idempotencyKey,
    correlationId: p.correlationId ?? 'unknown',
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

/**
 * Durable, idempotent submission. Reuses ExecutionStore.execution_jobs -
 * no second job table, no second lease system. Returns the existing job
 * if the idempotency key is already known.
 */
export function submitPipelineExecution(store: ExecutionStore, input: SubmitPipelineInput): SubmitPipelineResult {
  const idempotencyKey = input.idempotencyKey
    ?? `pipeline:${input.pipelineId}:${input.pipelineVersion}:${input.revision}:${input.correlationId}`;

  const existing = store.getJobByIdempotencyKey(idempotencyKey);
  if (existing) {
    return { execution: projectPipelineExecution(existing), job: existing, created: false };
  }

  const now = Date.now();
  const job: ExecutionJob = {
    id: randomUUID(),
    idempotencyKey,
    jobType: 'pipeline',
    payload: {
      kind: 'pipeline',
      pipelineId: input.pipelineId,
      pipelineVersion: input.pipelineVersion,
      repository: input.repository,
      revision: input.revision,
      actor: input.actor,
      trigger: input.trigger,
      tenantId: input.tenantId,
      correlationId: input.correlationId,
    },
    status: 'QUEUED',
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    cancellationAcknowledged: false,
  };

  try {
    store.createJob(job);
    return { execution: projectPipelineExecution(job), job, created: true };
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err?.message)) {
      const raced = store.getJobByIdempotencyKey(idempotencyKey);
      if (!raced) throw err;
      return { execution: projectPipelineExecution(raced), job: raced, created: false };
    }
    throw err;
  }
}