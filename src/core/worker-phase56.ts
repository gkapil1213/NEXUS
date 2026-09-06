import { randomUUID } from 'crypto';

export type Domain = 'DECISION' | 'EXECUTION' | 'OBSERVABILITY' | 'INCIDENT' | 'RECOVERY' | 'OPTIMIZATION' | 'COMPLIANCE' | 'KNOWLEDGE' | 'EVIDENCE' | 'AUDIT' | 'LINEAGE' | 'LEARNING' | 'GOVERNANCE' | 'SAFETY' | 'ROLLBACK' | 'VERIFICATION' | 'APPROVAL' | 'RESOURCE' | 'PROVIDER';
export type DomainHealth = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export type ContractCompatibility = 'compatible' | 'incompatible' | 'unknown';
export type GovernanceDecision = 'ALLOW' | 'DENY' | 'APPROVAL_REQUIRED' | 'FREEZE';
export type ApprovalDecision = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'INVALID';

interface DomainRegistration {
  domain: Domain;
  capabilities: Set<string>;
  provider?: string;
  version: string;
  contractVersion: string;
  healthState: DomainHealth;
  enabled: boolean;
}

interface ExecutionRecord {
  executionId: string;
  domain: Domain;
  capability: string;
  state: string;
  idempotencyKey: string;
}

const domains = new Map<Domain, DomainRegistration>();
const executions = new Map<string, ExecutionRecord>();

function normalizeDomain(input: string): Domain {
  return input.toUpperCase() as Domain;
}

export function registerDomain(domain: string, options: { capabilities?: string[]; provider?: string; version?: string; contractVersion?: string; healthState?: DomainHealth; enabled?: boolean } = {}): { domain: Domain; registered: boolean } {
  const key = normalizeDomain(domain);
  if (domains.has(key)) return { domain: key, registered: false };
  domains.set(key, {
    domain: key,
    capabilities: new Set(options.capabilities || []),
    provider: options.provider,
    version: options.version || '1.0.0',
    contractVersion: options.contractVersion || '1.0.0',
    healthState: options.healthState || 'unknown',
    enabled: options.enabled !== undefined ? options.enabled : true,
  });
  return { domain: key, registered: true };
}

export function getDomain(domain: string): DomainRegistration | null {
  const key = normalizeDomain(domain);
  return domains.get(key) || null;
}

export function hasDomain(domain: string): boolean {
  return domains.has(normalizeDomain(domain));
}

export function registerCapability(domain: string, capability: string): { domain: Domain; capability: string; registered: boolean } {
  const key = normalizeDomain(domain);
  const dom = domains.get(key);
  if (!dom) return { domain: key, capability, registered: false };
  const cap = capability.toLowerCase();
  if (dom.capabilities.has(cap)) return { domain: key, capability: cap, registered: false };
  dom.capabilities.add(cap);
  domains.set(key, dom);
  return { domain: key, capability: cap, registered: true };
}

export function getCapability(domain: string, capability: string): { domain: Domain; capability: string; enabled: boolean } | null {
  const key = normalizeDomain(domain);
  const dom = domains.get(key);
  if (!dom) return null;
  const cap = capability.toLowerCase();
  if (!dom.capabilities.has(cap)) return null;
  return { domain: key, capability: cap, enabled: dom.enabled };
}

export function hasCapability(domain: string, capability: string): boolean {
  const cap = getCapability(domain, capability);
  return cap !== null && cap.enabled;
}

export function validateContract(domain: string, contractVersion: string, requiredCapabilities: string[] = []): { conformant: boolean; violations: string[]; contractVersion: string } {
  const key = normalizeDomain(domain);
  const dom = domains.get(key);
  const violations: string[] = [];
  if (!dom) {
    violations.push(`unknown domain: ${key}`);
    return { conformant: false, violations, contractVersion };
  }
  if (dom.contractVersion !== contractVersion) {
    violations.push(`contract version mismatch: expected ${dom.contractVersion}, got ${contractVersion}`);
  }
  if (!dom.enabled) violations.push('domain disabled');
  if (dom.healthState === 'unavailable') violations.push('domain unavailable');
  if (dom.healthState === 'unknown') violations.push('domain health unknown');
  for (const cap of requiredCapabilities) {
    if (!dom.capabilities.has(cap.toLowerCase())) violations.push(`missing capability: ${cap}`);
  }
  return { conformant: violations.length === 0, violations, contractVersion };
}

export function checkCompatibility(domain: string, requestedVersion: string, provider?: string): { compatible: ContractCompatibility; reasons: string[] } {
  const key = normalizeDomain(domain);
  const dom = domains.get(key);
  const reasons: string[] = [];
  if (!dom) return { compatible: 'unknown', reasons: ['unknown domain'] };
  if (dom.version !== requestedVersion) reasons.push(`version mismatch: ${dom.version} vs ${requestedVersion}`);
  if (provider && dom.provider && dom.provider !== provider) reasons.push(`provider mismatch: ${dom.provider} vs ${provider}`);
  if (reasons.length > 0) return { compatible: 'incompatible', reasons };
  return { compatible: 'compatible', reasons: [] };
}

export function checkDomainHealth(domain: string): { domain: Domain; healthState: DomainHealth; safe: boolean } {
  const key = normalizeDomain(domain);
  const dom = domains.get(key);
  const health = dom?.healthState || 'unknown';
  const safe = health === 'healthy' || health === 'degraded';
  return { domain: key, healthState: health, safe };
}

export function authorizeInvocation(domain: string, capability: string, authorized: boolean): { authorized: boolean; reason?: string } {
  if (!hasDomain(domain)) return { authorized: false, reason: 'unknown domain' };
  if (!hasCapability(domain, capability)) return { authorized: false, reason: 'unknown capability' };
  if (!authorized) return { authorized: false, reason: 'authorization denied' };
  return { authorized: true };
}

export function evaluateGovernance(domain: string, riskLevel?: 'low'|'medium'|'high'|'critical', freeze?: boolean, deny?: boolean): { decision: GovernanceDecision } {
  if (freeze) return { decision: 'FREEZE' };
  if (deny) return { decision: 'DENY' };
  if (riskLevel === 'high' || riskLevel === 'critical') return { decision: 'APPROVAL_REQUIRED' };
  return { decision: 'ALLOW' };
}

export function evaluateApproval(approval: { decision: ApprovalDecision; expiresAt?: string }): { valid: boolean; decision: ApprovalDecision } {
  const now = Date.now();
  if (approval.decision === 'APPROVED') {
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() < now) return { valid: false, decision: 'EXPIRED' };
    return { valid: true, decision: 'APPROVED' };
  }
  return { valid: false, decision: approval.decision };
}

export function createExecution(domain: string, capability: string, idempotencyKey: string): { executionId: string; state: string } {
  const existing = Array.from(executions.values()).find(e => e.idempotencyKey === idempotencyKey);
  if (existing) return { executionId: existing.executionId, state: existing.state };
  const executionId = randomUUID();
  executions.set(executionId, { executionId, domain: normalizeDomain(domain), capability: capability.toLowerCase(), state: 'created', idempotencyKey });
  return { executionId, state: 'created' };
}

const validTransitions: Record<string, string[]> = {
  created: ['approved', 'cancelled'],
  approved: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'halted', 'verifying'],
  verifying: ['succeeded', 'failed', 'regression'],
  succeeded: [],
  failed: ['rolled_back'],
  halted: ['cancelled'],
  rolled_back: [],
  cancelled: [],
  regression: ['rolled_back']
};

export function transitionExecution(executionId: string, from: string, to: string): { valid: boolean; state: string } {
  const exec = executions.get(executionId);
  if (!exec) return { valid: false, state: 'unknown' };
  if (exec.state !== from) return { valid: false, state: exec.state };
  const allowed = validTransitions[from] || [];
  if (!allowed.includes(to)) return { valid: false, state: exec.state };
  exec.state = to;
  executions.set(executionId, exec);
  return { valid: true, state: to };
}

export function verifyExecution(executionId: string, result: 'success' | 'failure' | 'partial' | 'regression' | 'unknown'): { state: string } {
  const state = result === 'success' ? 'succeeded' : result === 'failure' ? 'failed' : result === 'regression' ? 'regression' : result === 'partial' ? 'succeeded' : 'failed';
  return { state };
}

export function rollbackExecution(executionId: string, idempotencyKey: string): { rollbackId: string; state: string } {
  return { rollbackId: randomUUID(), state: 'rolled_back' };
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

export function orchestrateCrossDomain(domainsToUse: string[], requiredCapabilities: Record<string, string[]> = {}): { success: boolean; steps: string[]; error?: string } {
  const steps: string[] = [];
  for (const domain of domainsToUse) {
    const key = normalizeDomain(domain);
    if (!hasDomain(key)) return { success: false, steps, error: `missing required domain: ${key}` };
    const dom = getDomain(key)!;
    if (!dom.enabled) return { success: false, steps, error: `domain disabled: ${key}` };
    if (dom.healthState === 'unavailable' || dom.healthState === 'unknown') {
      return { success: false, steps, error: `domain health ${dom.healthState}: ${key}` };
    }
    const caps = requiredCapabilities[domain] || [];
    for (const cap of caps) {
      if (!hasCapability(key, cap)) return { success: false, steps, error: `missing required capability: ${cap} in ${key}` };
    }
    steps.push(`${key} resolved`);
  }
  return { success: true, steps };
}

export function replayOperation(input: { domain: string; capability?: string }): { replayed: boolean; divergenceDetected: boolean; result: string } {
  const domain = normalizeDomain(input.domain);
  if (!hasDomain(domain)) return { replayed: true, divergenceDetected: false, result: 'unknown_domain' };
  if (input.capability && !hasCapability(domain, input.capability)) return { replayed: true, divergenceDetected: false, result: 'unknown_capability' };
  return { replayed: true, divergenceDetected: false, result: 'resolved' };
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
