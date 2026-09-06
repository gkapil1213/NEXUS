import { randomUUID } from 'crypto';

export type EnvironmentHealth = 'HEALTHY'|'DEGRADED'|'UNAVAILABLE'|'UNKNOWN'|'FROZEN'|'MAINTENANCE';
export type GovernanceDecision = 'ALLOW'|'REQUIRE_APPROVAL'|'DENY'|'FREEZE';

interface EnvironmentRecord {
  id: string;
  key: string;
  name: string;
  type: string;
  provider?: string;
  region?: string;
  health: EnvironmentHealth;
  capabilities: Set<string>;
  dependencies: Set<string>;
  frozen: boolean;
  configFingerprint?: string;
  lifecycleState: string;
  trustLevel: string;
  criticality: string;
}

interface AgentRecord {
  id: string;
  key: string;
  environmentId: string;
  capabilities: Set<string>;
  health: string;
  availability: string;
  trust: string;
  status: string;
  leaseExpiry?: string;
}

interface OperationRecord {
  id: string;
  objectiveId: string;
  sourceEnv: string;
  targetEnv: string;
  type: string;
  state: string;
  governance: string;
  safety: string;
  priority: number;
  risk: string;
  idempotencyKey: string;
}

const environments = new Map<string, EnvironmentRecord>();
const agents = new Map<string, AgentRecord>();
const operations = new Map<string, OperationRecord>();
const leases = new Map<string, { leaseToken: string; operationId: string; agentId: string; state: string; expiresAt: string }>();
const incidents = new Map<string, { signature: string; operationId: string; severity: string }>();
const breakerState = { state: 'CLOSED' as 'CLOSED'|'OPEN'|'HALF_OPEN', failures: 0 };

function normalizeEnv(input: string): string { return input.toUpperCase(); }

// Environment registry
export function createEnvironment(input: any): EnvironmentRecord {
  const id = input.idempotencyKey || randomUUID();
  if (environments.has(id)) return environments.get(id)!;
  const env: EnvironmentRecord = {
    id,
    key: input.key || id,
    name: input.name || id,
    type: input.type || 'generic',
    provider: input.provider,
    region: input.region,
    health: input.health || 'UNKNOWN',
    capabilities: new Set(input.capabilities || []),
    dependencies: new Set(),
    frozen: input.frozen || false,
    configFingerprint: input.configFingerprint,
    lifecycleState: input.lifecycleState || 'active',
    trustLevel: input.trustLevel || 'low',
    criticality: input.criticality || 'low',
  };
  environments.set(id, env);
  return env;
}

export function getEnvironment(id: string): EnvironmentRecord | null {
  return environments.get(id) || null;
}

export function listEnvironments(): EnvironmentRecord[] {
  return Array.from(environments.values());
}

export function updateEnvironment(id: string, updates: Partial<EnvironmentRecord>): EnvironmentRecord | null {
  const env = environments.get(id);
  if (!env) return null;
  Object.assign(env, updates);
  return env;
}

export function disableEnvironment(id: string): EnvironmentRecord | null {
  const env = environments.get(id);
  if (!env) return null;
  env.lifecycleState = 'disabled';
  return env;
}

export function validateEnvironment(id: string): { valid: boolean; reasons: string[] } {
  const env = environments.get(id);
  const reasons: string[] = [];
  if (!env) return { valid: false, reasons: ['unknown environment'] };
  if (env.lifecycleState === 'disabled') reasons.push('environment disabled');
  if (env.health === 'UNAVAILABLE') reasons.push('environment unavailable');
  if (env.health === 'UNKNOWN') reasons.push('environment health unknown');
  if (env.frozen) reasons.push('environment frozen');
  return { valid: reasons.length === 0, reasons };
}

export function assignCapabilities(id: string, capabilities: string[]): boolean {
  const env = environments.get(id);
  if (!env) return false;
  capabilities.forEach(c => env.capabilities.add(c.toLowerCase()));
  return true;
}

export function discoverEnvironment(key: string): EnvironmentRecord | null {
  for (const env of environments.values()) {
    if (env.key === key) return env;
  }
  return null;
}

export function observeEnvironment(id: string, health: EnvironmentHealth): EnvironmentRecord | null {
  const env = environments.get(id);
  if (!env) return null;
  env.health = health;
  return env;
}

export function computeEnvironmentFingerprint(env: EnvironmentRecord): string {
  return `${env.key}:${env.type}:${env.provider || ''}:${env.region || ''}:${env.configFingerprint || ''}`;
}

// Environment health
export function evaluateHealth(health: EnvironmentHealth): { safeForHighRisk: boolean; safeForLowRisk: boolean } {
  return {
    safeForHighRisk: health === 'HEALTHY',
    safeForLowRisk: health === 'HEALTHY' || health === 'DEGRADED',
  };
}

// Runtime agents
export function registerAgent(input: any): AgentRecord {
  const id = input.idempotencyKey || randomUUID();
  if (agents.has(id)) return agents.get(id)!;
  const agent: AgentRecord = {
    id,
    key: input.key || id,
    environmentId: input.environmentId,
    capabilities: new Set(input.capabilities || []),
    health: input.health || 'unknown',
    availability: input.availability || 'unknown',
    trust: input.trust || 'low',
    status: input.status || 'active',
    leaseExpiry: input.leaseExpiry,
  };
  agents.set(id, agent);
  return agent;
}

export function discoverAgent(key: string): AgentRecord | null {
  for (const agent of agents.values()) {
    if (agent.key === key) return agent;
  }
  return null;
}

export function heartbeat(agentId: string): { status: string; timestamp: string } {
  const agent = agents.get(agentId);
  if (!agent) return { status: 'unknown', timestamp: new Date().toISOString() };
  agent.status = 'active';
  return { status: 'active', timestamp: new Date().toISOString() };
}

export function assignCapabilitiesToAgent(agentId: string, capabilities: string[]): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  capabilities.forEach(c => agent.capabilities.add(c.toLowerCase()));
  return true;
}

export function markAgentUnavailable(agentId: string): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agent.status = 'unavailable';
  return true;
}

// Lease
export function acquireLease(operationId: string, agentId: string, durationMs: number = 60000): { leaseToken: string; state: string } {
  if (leases.has(operationId)) return { leaseToken: leases.get(operationId)!.leaseToken, state: 'existing' };
  const leaseToken = randomUUID();
  leases.set(operationId, { leaseToken, operationId, agentId, state: 'active', expiresAt: new Date(Date.now() + durationMs).toISOString() });
  return { leaseToken, state: 'active' };
}

export function renewLease(operationId: string, durationMs: number = 60000): boolean {
  const lease = leases.get(operationId);
  if (!lease) return false;
  lease.expiresAt = new Date(Date.now() + durationMs).toISOString();
  return true;
}

export function releaseLease(operationId: string): boolean {
  const lease = leases.get(operationId);
  if (!lease) return false;
  lease.state = 'released';
  return true;
}

export function detectExpiredLeases(): string[] {
  const now = Date.now();
  const expired: string[] = [];
  for (const [opId, lease] of leases) {
    if (lease.state === 'active' && new Date(lease.expiresAt).getTime() < now) expired.push(opId);
  }
  return expired;
}

// Objective
export function createObjective(input: any): { id: string } {
  const id = input.idempotencyKey || randomUUID();
  return { id };
}

export function validateObjective(input: any): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.type) reasons.push('missing type');
  if (!input.targetEnvironment) reasons.push('missing target environment');
  return { valid: reasons.length === 0, reasons };
}

// Targeting
export function selectTargets(objective: any, candidates: string[]): { allowed: string[]; rejected: { env: string; reason: string }[] } {
  const allowed: string[] = [];
  const rejected: { env: string; reason: string }[] = [];
  for (const envId of candidates) {
    const env = environments.get(envId);
    if (!env) { rejected.push({ env: envId, reason: 'unknown environment' }); continue; }
    const valid = validateEnvironment(envId);
    if (!valid.valid) { rejected.push({ env: envId, reason: valid.reasons.join(', ') }); continue; }
    allowed.push(envId);
  }
  return { allowed, rejected };
}

// Dependency
export function registerDependency(sourceEnvId: string, targetEnvId: string): boolean {
  const source = environments.get(sourceEnvId);
  const target = environments.get(targetEnvId);
  if (!source || !target) return false;
  source.dependencies.add(targetEnvId);
  return true;
}

export function detectCircularDependency(envId: string, visited: Set<string> = new Set(), stack: Set<string> = new Set()): boolean {
  if (stack.has(envId)) return true;
  if (visited.has(envId)) return false;
  visited.add(envId);
  stack.add(envId);
  const env = environments.get(envId);
  if (!env) return false;
  for (const dep of env.dependencies) {
    if (detectCircularDependency(dep, visited, stack)) return true;
  }
  stack.delete(envId);
  return false;
}

// Governance & Safety
export function evaluateGovernance(riskLevel?: string, freeze?: boolean, deny?: boolean): { decision: GovernanceDecision } {
  if (freeze) return { decision: 'FREEZE' };
  if (deny) return { decision: 'DENY' };
  if (riskLevel === 'high' || riskLevel === 'critical') return { decision: 'REQUIRE_APPROVAL' };
  return { decision: 'ALLOW' };
}

export function evaluateSafety(input: any): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.unknownEnvironment) reasons.push('unknown environment');
  if (input.unknownProvider) reasons.push('unknown provider');
  if (input.unknownHealth) reasons.push('unknown health');
  if (input.missingRollback) reasons.push('missing rollback');
  if (input.missingVerification) reasons.push('missing verification');
  if (input.excessiveBlastRadius) reasons.push('excessive blast radius');
  if (input.frozenTarget) reasons.push('frozen target');
  if (input.leaseConflict) reasons.push('lease conflict');
  if (input.dependencyFailure) reasons.push('dependency failure');
  return { safe: reasons.length === 0, reasons };
}

// Coordination
export function createOperation(input: any): OperationRecord {
  const id = input.idempotencyKey || randomUUID();
  if (operations.has(id)) return operations.get(id)!;
  const op: OperationRecord = {
    id,
    objectiveId: input.objectiveId || '',
    sourceEnv: input.sourceEnv || '',
    targetEnv: input.targetEnv || '',
    type: input.type || 'generic',
    state: input.state || 'CREATED',
    governance: input.governance || 'UNKNOWN',
    safety: input.safety || 'UNKNOWN',
    priority: input.priority || 0,
    risk: input.risk || 'medium',
    idempotencyKey: id,
  };
  operations.set(id, op);
  return op;
}

export function detectConflicts(targetEnv: string): string[] {
  const conflicts: string[] = [];
  for (const op of operations.values()) {
    if (op.targetEnv === targetEnv && op.state !== 'SUCCEEDED' && op.state !== 'CANCELLED') {
      conflicts.push(op.id);
    }
  }
  return conflicts;
}

// Promotion
export function createPromotion(input: any): { id: string; state: string } {
  const id = input.idempotencyKey || randomUUID();
  return { id, state: 'pending' };
}

// Execution
export function transitionExecution(operationId: string, from: string, to: string): { valid: boolean; state: string } {
  const op = operations.get(operationId);
  if (!op) return { valid: false, state: 'UNKNOWN' };
  const validTransitions: Record<string, string[]> = {
    CREATED: ['VALIDATING', 'CANCELLED'],
    VALIDATING: ['APPROVAL_REQUIRED', 'APPROVED', 'BLOCKED', 'FAILED'],
    APPROVAL_REQUIRED: ['APPROVED', 'BLOCKED', 'DENIED'],
    APPROVED: ['QUEUED', 'RUNNING', 'CANCELLED'],
    QUEUED: ['RUNNING', 'CANCELLED'],
    RUNNING: ['VERIFYING', 'FAILED', 'HALTED', 'ROLLING_BACK'],
    VERIFYING: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'ROLLING_BACK'],
    PARTIAL: ['SUCCEEDED', 'FAILED'],
    FAILED: ['ROLLING_BACK', 'RECOVERY_REQUIRED'],
    HALTED: ['CANCELLED', 'ROLLING_BACK'],
    ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
    ROLLED_BACK: [],
    RECOVERY_REQUIRED: ['RECOVERING', 'FAILED'],
    RECOVERING: ['RUNNING', 'FAILED'],
    BLOCKED: ['CANCELLED', 'FAILED'],
    SUCCEEDED: [],
    CANCELLED: [],
    DENIED: [],
  };
  if (op.state !== from) return { valid: false, state: op.state };
  const allowed = validTransitions[from] || [];
  if (!allowed.includes(to)) return { valid: false, state: op.state };
  op.state = to;
  operations.set(operationId, op);
  return { valid: true, state: to };
}

// Circuit breaker
export function circuitBreakerState(): { state: string; failures: number } {
  return { state: breakerState.state, failures: breakerState.failures };
}

export function transitionBreaker(to: 'CLOSED'|'OPEN'|'HALF_OPEN'): void {
  breakerState.state = to;
  if (to === 'OPEN') breakerState.failures++;
}

export function isBreakerOpen(): boolean {
  return breakerState.state === 'OPEN';
}

// Verification
export function verifyOperation(operationId: string, result: 'success'|'failure'|'partial'|'regression'|'unknown'): string {
  const op = operations.get(operationId);
  if (!op) return 'UNKNOWN';
  switch (result) {
    case 'success': return 'SUCCEEDED';
    case 'failure': return 'FAILED';
    case 'partial': return 'PARTIAL';
    case 'regression': return 'ROLLING_BACK';
    default: return 'UNKNOWN';
  }
}

// Rollback
export function rollbackOperation(operationId: string): { id: string; state: string } {
  return { id: randomUUID(), state: 'ROLLED_BACK' };
}

// Recovery
export function recoverOperation(operationId: string): { id: string; state: string } {
  return { id: randomUUID(), state: 'RECOVERING' };
}

// Incident
export function createIncident(operationId: string, severity: string): { id: string; signature: string } {
  const signature = `${operationId}:${severity}`;
  incidents.set(signature, { signature, operationId, severity });
  return { id: randomUUID(), signature };
}

export function duplicateIncident(signature: string): boolean {
  return incidents.has(signature);
}

// Evidence, Audit, Lineage, Learning, Replay
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

export function replayCoordinationDecision(input: any): { replayed: boolean; divergenceDetected: boolean; result: string } {
  return { replayed: true, divergenceDetected: false, result: 'resolved' };
}

// Redaction
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

