import { randomUUID } from 'crypto';

export type StageStatus =
  | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';

export interface StageExecution {
  stageExecutionId: string;
  executionId: string;
  tenantId: string;
  correlationId: string;
  stageName: string;
  attempt: number;
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
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  workerId?: string;
  leaseId?: string;
  evidenceRef?: string;
  /**
   * Phase 202b: durable projection of the underlying ExecutionJob.status.
   * Stage status collapses RETRY_SCHEDULED and DEAD_LETTER into FAILED;
   * this field preserves the true job state so dependency eligibility can
   * distinguish "retrying" from "terminal failure". Optional so existing
   * callers that construct StageExecution literals remain valid.
   */
  derivedJobStatus?: string;
}

const VALID_TRANSITIONS: Record<StageStatus, StageStatus[]> = {
  PENDING: ['RUNNING', 'SKIPPED', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED:    ['RUNNING'],
  SKIPPED:   [],
  CANCELLED: [],
};

export function createStageExecution(
  input: Omit<
    StageExecution,
    'stageExecutionId' | 'createdAt' | 'updatedAt' | 'status'
    | 'attempt' | 'idempotencyKey' | 'workerId' | 'leaseId' | 'evidenceRef'
  > & { idempotencyKey?: string; attempt?: number }
): StageExecution {
  const attempt = input.attempt ?? 1;
  const idempotencyKey =
    input.idempotencyKey ??
    `${input.executionId}:${input.stageName}:${attempt}`;
  const now = new Date().toISOString();
  return {
    stageExecutionId: randomUUID(),
    ...input,
    attempt,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function transitionStageExecution(
  stage: StageExecution,
  next: StageStatus
): StageExecution {
  if (!VALID_TRANSITIONS[stage.status].includes(next)) {
    throw new Error(`Illegal stage transition from ${stage.status} to ${next}`);
  }
  const now = new Date().toISOString();
  const updated: StageExecution = { ...stage, status: next, updatedAt: now };

  if (next === 'RUNNING') {
    if (stage.status === 'FAILED') {
      updated.attempt = stage.attempt + 1;
      updated.startedAt = now;
      updated.endedAt = undefined;
      updated.durationMs = undefined;
      updated.failureReason = undefined;
    } else {
      updated.startedAt = stage.startedAt ?? now;
    }
  }

  if (next === 'SUCCEEDED' || next === 'FAILED' || next === 'CANCELLED' || next === 'SKIPPED') {
    updated.endedAt = now;
    if (updated.startedAt) {
      updated.durationMs = Date.parse(now) - Date.parse(updated.startedAt);
    }
  }
  return updated;
}

export interface StageTransitionEvidence {
  correlationId: string;
  executionId: string;
  stageExecutionId: string;
  from: StageStatus;
  to: StageStatus;
  workerId: string;
  leaseId: string;
  reason?: string;
  at: string;
}

export interface StageExecutionPersistencePort {
  findByKey(idempotencyKey: string): Promise<StageExecution | null>;
  findById(stageExecutionId: string): Promise<StageExecution | null>;
  insertIfAbsent(stage: StageExecution): Promise<StageExecution>;
  transitionWithLease(args: {
    stageExecutionId: string;
    from: StageStatus;
    to: StageStatus;
    workerId: string;
    leaseId: string;
    patch?: Partial<StageExecution>;
    evidence: StageTransitionEvidence;
  }): Promise<StageExecution>;
}

export async function beginStage(args: {
  port: StageExecutionPersistencePort;
  input: Omit<
    StageExecution,
    'stageExecutionId' | 'createdAt' | 'updatedAt' | 'status'
    | 'attempt' | 'idempotencyKey' | 'workerId' | 'leaseId' | 'evidenceRef'
  > & { attempt?: number; idempotencyKey?: string };
  workerId: string;
  leaseId: string;
}): Promise<StageExecution> {
  const candidate = createStageExecution(args.input);
  const row = await args.port.insertIfAbsent(candidate);

  if (row.status !== 'PENDING') return row;

  const now = new Date().toISOString();
  return args.port.transitionWithLease({
    stageExecutionId: row.stageExecutionId,
    from: 'PENDING',
    to: 'RUNNING',
    workerId: args.workerId,
    leaseId: args.leaseId,
    patch: { startedAt: now, workerId: args.workerId, leaseId: args.leaseId },
    evidence: {
      correlationId: row.correlationId,
      executionId: row.executionId,
      stageExecutionId: row.stageExecutionId,
      from: 'PENDING',
      to: 'RUNNING',
      workerId: args.workerId,
      leaseId: args.leaseId,
      at: now,
    },
  });
}

export async function finishStage(args: {
  port: StageExecutionPersistencePort;
  stageExecutionId: string;
  next: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  workerId: string;
  leaseId: string;
  outputFingerprint?: string;
  artifactReferences?: string[];
  logsReference?: string;
  failureReason?: string;
}): Promise<StageExecution> {
  const current = await args.port.findById(args.stageExecutionId);
  if (!current) throw new Error(`Unknown stage ${args.stageExecutionId}`);

  if (current.status === 'SUCCEEDED' || current.status === 'FAILED' || current.status === 'CANCELLED') {
    if (current.status === args.next) return current;
    throw new Error(`Stage ${args.stageExecutionId} already terminal (${current.status})`);
  }
  if (current.status !== 'RUNNING') {
    throw new Error(`Cannot finish stage in status ${current.status}`);
  }

  const now = new Date().toISOString();
  const patch: Partial<StageExecution> = {
    endedAt: now,
    durationMs: current.startedAt ? Date.parse(now) - Date.parse(current.startedAt) : undefined,
    outputFingerprint: args.outputFingerprint,
    logsReference: args.logsReference,
    failureReason: args.failureReason,
  };
  if (args.artifactReferences) patch.artifactReferences = args.artifactReferences;

  return args.port.transitionWithLease({
    stageExecutionId: current.stageExecutionId,
    from: 'RUNNING',
    to: args.next,
    workerId: args.workerId,
    leaseId: args.leaseId,
    patch,
    evidence: {
      correlationId: current.correlationId,
      executionId: current.executionId,
      stageExecutionId: current.stageExecutionId,
      from: 'RUNNING',
      to: args.next,
      workerId: args.workerId,
      leaseId: args.leaseId,
      reason: args.failureReason,
      at: now,
    },
  });
}