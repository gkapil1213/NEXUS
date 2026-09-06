import { randomUUID } from 'crypto';

export type ProviderHealth = 'HEALTHY'|'DEGRADED'|'UNAVAILABLE'|'UNKNOWN';
export type ExecutionState = 'PLANNED'|'VALIDATING'|'AUTHORIZED'|'APPROVED'|'EXECUTING'|'SUBMITTED'|'OBSERVING'|'VERIFYING'|'SUCCEEDED'|'FAILED'|'ROLLING_BACK'|'ROLLED_BACK'|'ROLLBACK_FAILED'|'BLOCKED'|'CANCELLED';
export type ProtectionLevel = 'UNPROTECTED'|'STANDARD'|'SENSITIVE'|'PROTECTED'|'CRITICAL';
export type BlastRadius = 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'|'UNKNOWN';

interface ProviderRecord {
  id: string;
  name: string;
  type: string;
  status: string;
  health: ProviderHealth;
  capabilities: Set<string>;
  supportedOperations: Set<string>;
  environmentScope?: string;
  lastHealthCheck?: string;
}

interface EnvironmentRecord {
  id: string;
  name: string;
  type: string;
  providerId?: string;
  region?: string;
  lifecycleStatus: string;
  governancePolicyRef?: string;
  safetyPolicyRef?: string;
  health: string;
}

interface ResourceRecord {
  id: string;
  providerId: string;
  environmentId: string;
  type: string;
  providerResourceId?: string;
  name?: string;
  lifecycleState: string;
  protectionLevel: ProtectionLevel;
  capabilities: Set<string>;
  observedState?: string;
}

interface IntentRecord {
  id: string;
  intentId: string;
  decisionId?: string;
  environmentId: string;
  resourceId: string;
  operation: string;
  desiredState?: string;
  rationale?: string;
  evidenceReference?: string;
  risk?: string;
  confidence?: number;
  idempotencyKey: string;
}

interface PlanRecord {
  id: string;
  planId: string;
  intentId: string;
  providerId: string;
  environmentId: string;
  resourceId: string;
  operation: string;
  preconditions: string[];
  governanceChecks: string[];
  safetyChecks: string[];
  executionSteps: string[];
  verificationSteps: string[];
  rollbackPlan: string[];
  expectedOutcome: string;
  blastRadius: BlastRadius;
  timeoutSeconds?: number;
  idempotencyKey: string;
}

interface ExecutionRecord {
  id: string;
  executionId: string;
  planId: string;
  providerId: string;
  resourceId: string;
  operation: string;
  state: ExecutionState;
  providerResponse?: any;
  observedState?: string;
  verificationState?: string;
  rollbackState?: string;
  idempotencyKey: string;
}

const providers = new Map<string, ProviderRecord>();
const environments = new Map<string, EnvironmentRecord>();
const resources = new Map<string, ResourceRecord>();
const intents = new Map<string, IntentRecord>();
const plans = new Map<string, PlanRecord>();
const executions = new Map<string, ExecutionRecord>();

function normalize(input: string): string { return input.toUpperCase(); }

// Provider registry
export function createProvider(input: any): ProviderRecord {
  const id = input.idempotencyKey || randomUUID();
  if (providers.has(id)) return providers.get(id)!;
  const provider: ProviderRecord = {
    id,
    name: input.name || id,
    type: input.type || 'generic',
    status: input.status || 'active',
    health: input.health || 'UNKNOWN',
    capabilities: new Set(input.capabilities || []),
    supportedOperations: new Set(input.supportedOperations || []),
    environmentScope: input.environmentScope,
    lastHealthCheck: input.lastHealthCheck,
  };
  providers.set(id, provider);
  return provider;
}

export function getProvider(id: string): ProviderRecord | null { return providers.get(id) || null; }

export function registerCapability(providerId: string, capability: string, operation?: string): boolean {
  const provider = providers.get(providerId);
  if (!provider) return false;
  provider.capabilities.add(capability.toLowerCase());
  if (operation) provider.supportedOperations.add(operation.toLowerCase());
  return true;
}

export function providerHealthCheck(providerId: string): ProviderHealth {
  const provider = providers.get(providerId);
  return provider ? provider.health : 'UNKNOWN';
}

// Environment
export function createEnvironment(input: any): EnvironmentRecord {
  const id = input.idempotencyKey || randomUUID();
  if (environments.has(id)) return environments.get(id)!;
  const env: EnvironmentRecord = {
    id,
    name: input.name || id,
    type: input.type || 'development',
    providerId: input.providerId,
    region: input.region,
    lifecycleStatus: input.lifecycleStatus || 'active',
    governancePolicyRef: input.governancePolicyRef,
    safetyPolicyRef: input.safetyPolicyRef,
    health: input.health || 'unknown',
  };
  environments.set(id, env);
  return env;
}

// Resource
export function createResource(input: any): ResourceRecord {
  const id = input.idempotencyKey || randomUUID();
  if (resources.has(id)) return resources.get(id)!;
  const resource: ResourceRecord = {
    id,
    providerId: input.providerId,
    environmentId: input.environmentId,
    type: input.type || 'generic',
    providerResourceId: input.providerResourceId,
    name: input.name,
    lifecycleState: input.lifecycleState || 'active',
    protectionLevel: input.protectionLevel || 'STANDARD',
    capabilities: new Set(input.capabilities || []),
    observedState: input.observedState,
  };
  resources.set(id, resource);
  return resource;
}

export function getResource(id: string): ResourceRecord | null { return resources.get(id) || null; }

// Intent
export function createIntent(input: any): IntentRecord {
  const id = input.idempotencyKey || randomUUID();
  if (intents.has(id)) return intents.get(id)!;
  const intent: IntentRecord = {
    id,
    intentId: input.intentId || id,
    decisionId: input.decisionId,
    environmentId: input.environmentId,
    resourceId: input.resourceId,
    operation: input.operation,
    desiredState: input.desiredState,
    rationale: input.rationale,
    evidenceReference: input.evidenceReference,
    risk: input.risk,
    confidence: input.confidence,
    idempotencyKey: id,
  };
  intents.set(id, intent);
  return intent;
}

// Plan
export function createPlan(input: any): PlanRecord {
  const id = input.idempotencyKey || randomUUID();
  if (plans.has(id)) return plans.get(id)!;
  const plan: PlanRecord = {
    id,
    planId: input.planId || id,
    intentId: input.intentId,
    providerId: input.providerId,
    environmentId: input.environmentId,
    resourceId: input.resourceId,
    operation: input.operation,
    preconditions: input.preconditions || [],
    governanceChecks: input.governanceChecks || [],
    safetyChecks: input.safetyChecks || [],
    executionSteps: input.executionSteps || [],
    verificationSteps: input.verificationSteps || [],
    rollbackPlan: input.rollbackPlan || [],
    expectedOutcome: input.expectedOutcome || '',
    blastRadius: input.blastRadius || 'UNKNOWN',
    timeoutSeconds: input.timeoutSeconds,
    idempotencyKey: id,
  };
  plans.set(id, plan);
  return plan;
}

// Preconditions
export function validatePreconditions(plan: PlanRecord): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const provider = providers.get(plan.providerId);
  const env = environments.get(plan.environmentId);
  const resource = resources.get(plan.resourceId);
  if (!provider) reasons.push('provider not found');
  else if (provider.health === 'UNAVAILABLE' || provider.health === 'UNKNOWN') reasons.push(`provider health ${provider.health}`);
  if (!env) reasons.push('environment not found');
  if (!resource) reasons.push('resource not found');
  if (resource && !resource.capabilities.has(plan.operation.toLowerCase()) && !provider?.supportedOperations.has(plan.operation.toLowerCase())) reasons.push(`unsupported operation: ${plan.operation}`);
  if (resource?.protectionLevel === 'CRITICAL') reasons.push('critical resource requires explicit approval');
  if (!plan.rollbackPlan || plan.rollbackPlan.length === 0) reasons.push('missing rollback plan');
  if (!plan.verificationSteps || plan.verificationSteps.length === 0) reasons.push('missing verification steps');
  return { valid: reasons.length === 0, reasons };
}

// Governance/Safety
export function evaluateGovernance(plan: PlanRecord, freeze: boolean, deny: boolean): { decision: 'ALLOW'|'DENY'|'APPROVAL_REQUIRED'|'FREEZE' } {
  if (freeze) return { decision: 'FREEZE' };
  if (deny) return { decision: 'DENY' };
  if (plan.blastRadius === 'HIGH' || plan.blastRadius === 'CRITICAL') return { decision: 'APPROVAL_REQUIRED' };
  return { decision: 'ALLOW' };
}

export function evaluateSafety(plan: PlanRecord, input: any): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.unknownProvider) reasons.push('unknown provider');
  if (input.unknownResource) reasons.push('unknown resource');
  if (input.unknownEnvironment) reasons.push('unknown environment');
  if (input.excessiveBlastRadius) reasons.push('excessive blast radius');
  if (input.missingRollback) reasons.push('missing rollback');
  if (input.missingVerification) reasons.push('missing verification');
  if (input.insufficientEvidence) reasons.push('insufficient evidence');
  if (input.staleEvidence) reasons.push('stale evidence');
  if (input.unhealthyProvider) reasons.push('unhealthy provider');
  if (input.unhealthyEnvironment) reasons.push('unhealthy environment');
  if (input.activeIncident) reasons.push('active incident');
  if (input.governanceFreeze) reasons.push('governance freeze');
  return { safe: reasons.length === 0, reasons };
}

// Execution
export function createExecution(plan: PlanRecord, idempotencyKey?: string): ExecutionRecord {
  const id = idempotencyKey || plan.idempotencyKey || randomUUID();
  if (executions.has(id)) return executions.get(id)!;
  const execution: ExecutionRecord = {
    id,
    executionId: id,
    planId: plan.id,
    providerId: plan.providerId,
    resourceId: plan.resourceId,
    operation: plan.operation,
    state: 'PLANNED',
    idempotencyKey: id,
  };
  executions.set(id, execution);
  return execution;
}

const executionTransitions: Record<ExecutionState, ExecutionState[]> = {
  PLANNED: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['AUTHORIZED', 'BLOCKED', 'CANCELLED'],
  AUTHORIZED: ['APPROVED', 'BLOCKED', 'CANCELLED'],
  APPROVED: ['EXECUTING', 'BLOCKED', 'CANCELLED'],
  EXECUTING: ['SUBMITTED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  SUBMITTED: ['OBSERVING', 'FAILED', 'BLOCKED'],
  OBSERVING: ['VERIFYING', 'FAILED', 'BLOCKED'],
  VERIFYING: ['SUCCEEDED', 'FAILED', 'ROLLING_BACK'],
  SUCCEEDED: [],
  FAILED: ['ROLLING_BACK', 'CANCELLED'],
  ROLLING_BACK: ['ROLLED_BACK', 'ROLLBACK_FAILED'],
  ROLLED_BACK: [],
  ROLLBACK_FAILED: [],
  BLOCKED: ['CANCELLED', 'FAILED'],
  CANCELLED: [],
};

export function transitionExecution(executionId: string, to: ExecutionState): { valid: boolean; state: ExecutionState } {
  const exec = executions.get(executionId);
  if (!exec) return { valid: false, state: 'PLANNED' };
  const allowed = executionTransitions[exec.state] || [];
  if (!allowed.includes(to)) return { valid: false, state: exec.state };
  exec.state = to;
  executions.set(executionId, exec);
  return { valid: true, state: to };
}

// Provider execution simulation
export function executeProviderOperation(executionId: string, providerResponse: any, observedState?: string): { executionId: string; state: ExecutionState; providerResponse: any; observedState?: string } {
  const exec = executions.get(executionId);
  if (!exec) return { executionId, state: 'PLANNED', providerResponse };
  exec.providerResponse = providerResponse;
  exec.observedState = observedState;
  return { executionId, state: exec.state, providerResponse, observedState };
}

// Verification
export function verifyExecution(executionId: string, expectedState: string, observedState: string): { state: 'VERIFIED'|'PARTIAL'|'FAILED'|'REGRESSED'|'UNKNOWN'; matched: boolean } {
  const exec = executions.get(executionId);
  const matched = expectedState === observedState;
  if (exec) {
    exec.verificationState = matched ? 'VERIFIED' : 'FAILED';
    executions.set(executionId, exec);
  }
  return { state: matched ? 'VERIFIED' : 'FAILED', matched };
}

// Rollback
export function rollbackExecution(executionId: string): { rollbackId: string; state: ExecutionState } {
  return { rollbackId: randomUUID(), state: 'ROLLED_BACK' };
}

// Incidents
export function createIncident(operationId: string, severity: string): { signature: string } {
  return { signature: `${operationId}:${severity}` };
}

// Evidence, Audit, Lineage, Learning
export function generateEvidence(operationId: string, type: string, content: Record<string, unknown>): { evidenceId: string; operationId: string; type: string } {
  return { evidenceId: randomUUID(), operationId, type };
}
export function recordAudit(operationId: string, action: string): { auditId: string; operationId: string; action: string } {
  return { auditId: randomUUID(), operationId, action };
}
export function recordLineage(operationId: string): { lineageId: string; operationId: string } {
  return { lineageId: randomUUID(), operationId };
}
export function recordLearning(operationId: string, outcome: string): { learningId: string; operationId: string; outcome: string } {
  return { learningId: randomUUID(), operationId, outcome };
}

// Replay
export function replayDecision(input: any): { replayed: boolean; divergenceDetected: boolean; result: any } {
  return { replayed: true, divergenceDetected: false, result: input };
}

// Redaction
export function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/access[_-]?token\s*[:=]\s*\S+/gi, 'access_token=[REDACTED]');
}
