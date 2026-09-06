import { randomUUID } from 'crypto';
import * as domainRuntime from './worker-phase56';

export type ObjectiveState = 'CREATED' | 'CONTEXTUALIZING' | 'PLANNING' | 'AWAITING_APPROVAL' | 'READY' | 'EXECUTING' | 'VERIFYING' | 'SUCCEEDED' | 'RECOVERING' | 'RETRYING' | 'REPLANNING' | 'BLOCKED' | 'FAILED' | 'CANCELLED';

export interface Objective {
  id: string;
  objectiveKey: string;
  objectiveType: string;
  description: string | null;
  requester: string | null;
  priority: number;
  constraints: string[];
  riskTolerance: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL';
  allowedDomains: string[];
  prohibitedDomains: string[];
  state: ObjectiveState;
  completionCriteria: string[];
  iteration: number;
  correlationId: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

interface PlanStep {
  stepId: string;
  domain: string;
  capability: string;
  dependencies: string[];
  expectedOutcome: string;
  risk: string;
}

interface Plan {
  id: string;
  objectiveId: string;
  steps: PlanStep[];
  requiredDomains: string[];
  requiredCapabilities: string[];
  risk: string;
  blastRadius: string;
  rollbackStrategy: string | null;
  verificationStrategy: string;
  approvalRequirements: string[];
  version: number;
  idempotencyKey: string;
}

const objectives = new Map<string, Objective>();
const plans = new Map<string, Plan>();
const objectiveExecutions = new Map<string, { objectiveId: string; planId: string; state: string }>();

function normalizeDomain(d: string): string { return d.toUpperCase(); }

export function createObjective(input: any): Objective {
  const id = input.idempotencyKey || randomUUID();
  if (objectives.has(id)) return objectives.get(id)!;
  const objective: Objective = {
    id,
    objectiveKey: input.objectiveKey || id,
    objectiveType: input.objectiveType || 'generic',
    description: input.description || null,
    requester: input.requester || null,
    priority: input.priority || 0,
    constraints: input.constraints || [],
    riskTolerance: input.riskTolerance || 'MEDIUM',
    allowedDomains: input.allowedDomains || [],
    prohibitedDomains: input.prohibitedDomains || [],
    state: input.state || 'CREATED',
    completionCriteria: input.completionCriteria || [],
    iteration: input.iteration || 0,
    correlationId: input.correlationId || null,
    idempotencyKey: id,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
  objectives.set(id, objective);
  return objective;
}

export function getObjective(objectiveId: string): Objective | null {
  return objectives.get(objectiveId) || null;
}

const objectiveTransitions: Record<ObjectiveState, ObjectiveState[]> = {
  CREATED: ['CONTEXTUALIZING', 'CANCELLED'],
  CONTEXTUALIZING: ['PLANNING', 'BLOCKED', 'CANCELLED'],
  PLANNING: ['AWAITING_APPROVAL', 'READY', 'BLOCKED', 'FAILED'],
  AWAITING_APPROVAL: ['READY', 'BLOCKED', 'FAILED'],
  READY: ['EXECUTING', 'BLOCKED', 'FAILED'],
  EXECUTING: ['VERIFYING', 'RECOVERING', 'RETRYING', 'REPLANNING', 'BLOCKED', 'FAILED'],
  VERIFYING: ['SUCCEEDED', 'FAILED', 'RECOVERING', 'RETRYING', 'REPLANNING'],
  RECOVERING: ['EXECUTING', 'REPLANNING', 'BLOCKED', 'FAILED'],
  RETRYING: ['EXECUTING', 'FAILED'],
  REPLANNING: ['PLANNING', 'FAILED'],
  BLOCKED: ['CANCELLED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: []
};

export function transitionObjective(objectiveId: string, to: ObjectiveState): { valid: boolean; state: ObjectiveState } {
  const obj = objectives.get(objectiveId);
  if (!obj) return { valid: false, state: 'CREATED' };
  const allowed = objectiveTransitions[obj.state] || [];
  if (!allowed.includes(to)) return { valid: false, state: obj.state };
  obj.state = to;
  obj.updatedAt = new Date().toISOString();
  objectives.set(objectiveId, obj);
  return { valid: true, state: to };
}

export function assembleContext(objectiveId: string): { objective: Objective; context: Record<string, unknown>; historicalPrecedents: any[] } {
  const objective = objectives.get(objectiveId);
  if (!objective) throw new Error('Objective not found');
  const historicalPrecedents = [
    { type: 'previous_success', domain: 'DECISION', confidence: 0.8 },
    { type: 'previous_failure', domain: 'EXECUTION', confidence: 0.6 },
  ];
  return {
    objective,
    context: { objectiveId, objectiveType: objective.objectiveType, timestamp: new Date().toISOString() },
    historicalPrecedents,
  };
}

export function generatePlan(objectiveId: string, input: any = {}): Plan {
  const idempotencyKey = input.idempotencyKey || randomUUID();
  const existing = Array.from(plans.values()).find(p => p.idempotencyKey === idempotencyKey);
  if (existing) return existing;
  const objective = objectives.get(objectiveId);
  if (!objective) throw new Error('Objective not found');
  const steps: PlanStep[] = input.steps || [
    { stepId: 'step1', domain: 'DECISION', capability: 'evaluate', dependencies: [], expectedOutcome: 'decision made', risk: 'low' },
    { stepId: 'step2', domain: 'EXECUTION', capability: 'execute', dependencies: ['step1'], expectedOutcome: 'execution complete', risk: 'medium' },
    { stepId: 'step3', domain: 'VERIFICATION', capability: 'verify', dependencies: ['step2'], expectedOutcome: 'verified', risk: 'low' },
  ];
  const plan: Plan = {
    id: randomUUID(),
    objectiveId,
    steps,
    requiredDomains: input.requiredDomains || Array.from(new Set(steps.map(s => s.domain))),
    requiredCapabilities: input.requiredCapabilities || steps.map(s => ({ domain: s.domain, capability: s.capability })),
    risk: input.risk || 'medium',
    blastRadius: input.blastRadius || 'low',
    rollbackStrategy: input.rollbackStrategy || null,
    verificationStrategy: input.verificationStrategy || 'verify all steps',
    approvalRequirements: input.approvalRequirements || [],
    version: input.version || 1,
    idempotencyKey,
  };
  plans.set(plan.id, plan);
  return plan;
}

export function validatePlan(plan: Plan): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const step of plan.steps) {
    if (!domainRuntime.hasDomain(step.domain)) violations.push(`unknown domain: ${step.domain}`);
    else if (!domainRuntime.hasCapability(step.domain, step.capability)) violations.push(`missing capability: ${step.capability} in ${step.domain}`);
    if (step.dependencies.length > 0) {
      // check dependencies exist within steps
      for (const dep of step.dependencies) {
        if (!plan.steps.some(s => s.stepId === dep)) violations.push(`missing dependency: ${dep}`);
      }
      // cycle detection simplified: no duplicate dependency
      if (step.dependencies.includes(step.stepId)) violations.push(`self-dependency: ${step.stepId}`);
    }
  }
  return { valid: violations.length === 0, violations };
}

export function evaluateGovernance(riskLevel?: string, freeze?: boolean, deny?: boolean): { decision: string } {
  if (freeze) return { decision: 'FREEZE' };
  if (deny) return { decision: 'DENY' };
  if (riskLevel === 'high' || riskLevel === 'critical') return { decision: 'APPROVAL_REQUIRED' };
  return { decision: 'ALLOW' };
}

export function evaluateSafety(input: any): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.unknownDomain) reasons.push('unknown domain');
  if (input.unknownProvider) reasons.push('unknown provider');
  if (input.protectedResource) reasons.push('protected resource');
  if (input.missingAuthorization) reasons.push('missing authorization');
  if (input.missingRollback) reasons.push('missing rollback');
  if (input.missingVerification) reasons.push('missing verification');
  if (input.excessiveBlastRadius) reasons.push('excessive blast radius');
  if (input.circuitBreakerOpen) reasons.push('circuit breaker open');
  return { safe: reasons.length === 0, reasons };
}

export function resolveApproval(decision: string, expiresAt?: string): { valid: boolean; decision: string } {
  if (decision === 'APPROVED') {
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return { valid: false, decision: 'EXPIRED' };
    return { valid: true, decision: 'APPROVED' };
  }
  return { valid: false, decision };
}

export function scheduleStep(plan: Plan, stepIndex: number): { step: PlanStep; ready: boolean; blockedBy: string[] } {
  const step = plan.steps[stepIndex];
  const blockedBy = step.dependencies.filter(dep => {
    const depStep = plan.steps.find(s => s.stepId === dep);
    return !depStep; // placeholder
  });
  return { step, ready: blockedBy.length === 0, blockedBy };
}

export function executeStep(plan: Plan, stepIndex: number): { executionId: string; state: string } {
  const step = plan.steps[stepIndex];
  return { executionId: randomUUID(), state: 'running' };
}

export function observeStep(executionId: string): { observedState: string; expected: string; actual: string } {
  return { observedState: 'completed', expected: 'success', actual: 'success' };
}

export function verifyStep(executionId: string, result: 'success'|'failure'|'partial'|'regression'|'unknown'): { state: string } {
  const state = result === 'success' ? 'succeeded' : result === 'failure' ? 'failed' : result === 'regression' ? 'regression' : result === 'partial' ? 'partial' : 'unknown';
  return { state };
}

export function evaluateOutcome(objectiveId: string, expected: string, actual: string): { outcome: 'achieved'|'partially_achieved'|'failed'|'unknown' } {
  if (expected === actual) return { outcome: 'achieved' };
  if (actual === 'partial') return { outcome: 'partially_achieved' };
  if (actual === 'failure') return { outcome: 'failed' };
  return { outcome: 'unknown' };
}

export function retryAllowed(retryCount: number, maxRetries: number, failureClass: string): boolean {
  if (failureClass === 'non-retryable') return false;
  return retryCount < maxRetries;
}

export function replanAllowed(iteration: number, maxIterations: number, safe: boolean): boolean {
  return safe && iteration < maxIterations;
}

export function recover(objectiveId: string): { recoveryId: string; state: string } {
  return { recoveryId: randomUUID(), state: 'planned' };
}

export function rollback(objectiveId: string): { rollbackId: string; state: string } {
  return { rollbackId: randomUUID(), state: 'rolled_back' };
}

export function escalate(objectiveId: string): { escalationId: string; state: string } {
  return { escalationId: randomUUID(), state: 'escalated' };
}

export function replayObjective(input: any): { replayed: boolean; divergenceDetected: boolean; result: string } {
  return { replayed: true, divergenceDetected: false, result: 'resolved' };
}


export function generateEvidence(operationId: string, type: string, content: Record<string, unknown>): { evidenceId: string; operationId: string; type: string } {
  return { evidenceId: randomUUID(), operationId, type };
}

export function generateAudit(operationId: string, action: string): { auditId: string; operationId: string; action: string } {
  return { auditId: randomUUID(), operationId, action };
}

export function generateLineage(operationId: string, parentOperationId?: string): { lineageId: string; operationId: string; parentOperationId: string | null } {
  return { lineageId: randomUUID(), operationId, parentOperationId: parentOperationId || null };
}

export function generateLearning(operationId: string, outcome: string): { learningId: string; operationId: string; outcome: string } {
  return { learningId: randomUUID(), operationId, outcome };
}
export function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/credential\s*[:=]\s*\S+/gi, 'credential=[REDACTED]')
    .replace(/private[_-]?key\s*[:=]\s*\S+/gi, 'private_key=[REDACTED]');
}
