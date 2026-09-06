import { randomUUID, createHash } from 'crypto';
import * as T from './phase68-domain-types';

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function fingerprint(input: any): string {
  return hash(JSON.stringify(input));
}

const executions = new Map<string, T.Phase68Execution>();
const transitions = new Map<string, { id: string; executionId: string; fromState?: string; toState: string; reason?: string; transitionHash: string; createdAt: string }>();
const decisions = new Map<string, { id: string; executionId: string; decisionType: string; decision: string; rationale?: string; createdAt: string }>();

const validTransitions: Record<T.ExecutionState, T.ExecutionState[]> = {
  CREATED: ['CONTEXT_RESOLVED','CANCELLED','ESCALATED'],
  CONTEXT_RESOLVED: ['PLANNED','ESCALATED','FAILED'],
  PLANNED: ['AUTHORIZED','ESCALATED','FAILED','APPROVAL_REQUIRED'],
  AUTHORIZED: ['RISK_ASSESSED','APPROVAL_REQUIRED','FAILED'],
  RISK_ASSESSED: ['DECIDED','APPROVAL_REQUIRED','FAILED','ESCALATED'],
  DECIDED: ['APPROVAL_REQUIRED','APPROVED','FAILED','ESCALATED'],
  APPROVAL_REQUIRED: ['APPROVED','ESCALATED','FAILED'],
  APPROVED: ['EXECUTING','FAILED','CANCELLED'],
  EXECUTING: ['VALIDATING','FAILED','RECOVERING'],
  VALIDATING: ['EVIDENCE_CAPTURED','FAILED','RECOVERING'],
  EVIDENCE_CAPTURED: ['RELEASE_READY','RELEASE_BLOCKED','FAILED'],
  RELEASE_READY: ['DEPLOYING','APPROVAL_REQUIRED','FAILED'],
  RELEASE_BLOCKED: ['ESCALATED','FAILED'],
  DEPLOYING: ['DEPLOYED','FAILED','RECOVERING'],
  DEPLOYED: ['VERIFYING','FAILED','RECOVERING'],
  VERIFYING: ['HEALTHY','DEGRADED','RECOVERING','COMPLETED','FAILED'],
  HEALTHY: ['COMPLETED'],
  DEGRADED: ['RECOVERING','COMPLETED','FAILED'],
  RECOVERING: ['ROLLED_BACK','COMPLETED','FAILED','ESCALATED'],
  ROLLED_BACK: ['COMPLETED','FAILED'],
  COMPLETED: [],
  FAILED: ['ESCALATED','RECOVERING'],
  ESCALATED: [],
  CANCELLED: []
};

export function createExecution(request: T.Phase68Request): T.Phase68Execution {
  const id = request.idempotencyKey || request.executionId || randomUUID();
  if (executions.has(id)) return executions.get(id)!;
  const execution: T.Phase68Execution = {
    id,
    executionId: request.executionId || id,
    requestId: request.requestId,
    correlationId: request.correlationId,
    parentExecutionId: undefined,
    environmentId: request.environmentId,
    releaseId: request.releaseId,
    deploymentId: request.deploymentId,
    policyDecisionId: request.policyDecisionId,
    evidenceId: undefined,
    state: 'CREATED',
    idempotencyKey: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  executions.set(id, execution);
  return execution;
}

export function getExecution(id: string): T.Phase68Execution | null {
  return executions.get(id) || null;
}

export function transitionExecution(executionId: string, to: T.ExecutionState, reason?: string): { valid: boolean; state: T.ExecutionState } {
  const exec = executions.get(executionId);
  if (!exec) return { valid: false, state: 'CREATED' };
  const allowed = validTransitions[exec.state] || [];
  if (!allowed.includes(to)) return { valid: false, state: exec.state };
  const prev = exec.state;
  exec.state = to;
  exec.updatedAt = new Date().toISOString();
  executions.set(executionId, exec);
  const transitionHash = hash(`${executionId}:${prev}:${to}:${reason || ''}`);
  transitions.set(transitionHash, {
    id: randomUUID(),
    executionId,
    fromState: prev,
    toState: to,
    reason,
    transitionHash,
    createdAt: new Date().toISOString(),
  });
  return { valid: true, state: to };
}

export function recordDecision(executionId: string, decisionType: string, decision: string, rationale?: string): { decisionId: string } {
  const id = randomUUID();
  decisions.set(id, { id, executionId, decisionType, decision, rationale, createdAt: new Date().toISOString() });
  return { decisionId: id };
}

export function generateEvidence(executionId: string, type: string, content: Record<string, unknown>): { evidenceId: string; executionId: string; type: string } {
  return { evidenceId: randomUUID(), executionId, type };
}

export function recordAudit(executionId: string, action: string): { auditId: string; executionId: string; action: string } {
  return { auditId: randomUUID(), executionId, action };
}

export function recordLineage(executionId: string): { lineageId: string; executionId: string } {
  return { lineageId: randomUUID(), executionId };
}

export function recordLearning(executionId: string, outcome: string): { learningId: string; executionId: string; outcome: string } {
  return { learningId: randomUUID(), executionId, outcome };
}

export function replayExecution(request: T.Phase68Request): { replayed: boolean; divergenceDetected: boolean; result: T.Phase68Execution } {
  const first = createExecution(request);
  const second = createExecution(request);
  return { replayed: true, divergenceDetected: first.executionId !== second.executionId || first.state !== second.state, result: second };
}

export function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/access[_-]?token\s*[:=]\s*\S+/gi, 'access_token=[REDACTED]');
}
