import { randomUUID } from 'crypto';
import * as phase57 from './worker-phase57';

interface ObjectiveRef {
  objectiveId: string;
  priority: number;
  dependencies: string[];
  resourceRequirements: { type: string; amount: number }[];
  risk: string;
  deadline?: string;
  state: string;
  age: number;
}

interface Portfolio {
  id: string;
  name: string;
  objectives: Map<string, ObjectiveRef>;
  globalRiskBudget: number;
  globalAutonomyBudget: number;
  globalResourceBudget: number;
  schedulingState: string;
  version: number;
  lastDetectedVersion?: number;
}

const portfolios = new Map<string, Portfolio>();

function createObjectiveRef(input: any): ObjectiveRef {
  return {
    objectiveId: input.objectiveId,
    priority: input.priority || 0,
    dependencies: input.dependencies || [],
    resourceRequirements: input.resourceRequirements || [],
    risk: input.risk || 'medium',
    deadline: input.deadline,
    state: input.state || 'CREATED',
    age: input.age || 0,
  };
}

export function createPortfolio(input: any): { id: string; portfolioId: string } {
  const id = input.idempotencyKey || randomUUID();
  if (portfolios.has(id)) return { id, portfolioId: id };
  portfolios.set(id, {
    id,
    name: input.name || 'portfolio',
    objectives: new Map(),
    globalRiskBudget: input.globalRiskBudget || 100,
    globalAutonomyBudget: input.globalAutonomyBudget || 10,
    globalResourceBudget: input.globalResourceBudget || 100,
    schedulingState: 'ACTIVE',
    version: 0,
    lastDetectedVersion: 0,
  });
  return { id, portfolioId: id };
}

export function getPortfolio(portfolioId: string): Portfolio | null {
  return portfolios.get(portfolioId) || null;
}

export function registerObjective(portfolioId: string, input: any): { objectiveId: string; registered: boolean } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { objectiveId: input.objectiveId || '', registered: false };
  if (portfolio.objectives.has(input.objectiveId)) return { objectiveId: input.objectiveId, registered: false };
  portfolio.objectives.set(input.objectiveId, createObjectiveRef(input));
  portfolio.version++;
  return { objectiveId: input.objectiveId, registered: true };
}

export function removeObjective(portfolioId: string, objectiveId: string): { removed: boolean } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio || !portfolio.objectives.has(objectiveId)) return { removed: false };
  portfolio.objectives.delete(objectiveId);
  portfolio.version++;
  return { removed: true };
}

export function pauseObjective(portfolioId: string, objectiveId: string): { paused: boolean; state: string } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { paused: false, state: 'UNKNOWN' };
  const obj = portfolio.objectives.get(objectiveId);
  if (!obj) return { paused: false, state: 'UNKNOWN' };
  obj.state = 'PAUSED';
  portfolio.version++;
  return { paused: true, state: obj.state };
}

export function resumeObjective(portfolioId: string, objectiveId: string): { resumed: boolean; state: string } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { resumed: false, state: 'UNKNOWN' };
  const obj = portfolio.objectives.get(objectiveId);
  if (!obj) return { resumed: false, state: 'UNKNOWN' };
  obj.state = 'READY';
  portfolio.version++;
  return { resumed: true, state: obj.state };
}

export function cancelObjective(portfolioId: string, objectiveId: string): { cancelled: boolean; state: string } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { cancelled: false, state: 'UNKNOWN' };
  const obj = portfolio.objectives.get(objectiveId);
  if (!obj) return { cancelled: false, state: 'UNKNOWN' };
  obj.state = 'CANCELLED';
  portfolio.version++;
  return { cancelled: true, state: obj.state };
}

export function reprioritizeObjective(portfolioId: string, objectiveId: string, priority: number): { updated: boolean; priority: number } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { updated: false, priority: 0 };
  const obj = portfolio.objectives.get(objectiveId);
  if (!obj) return { updated: false, priority: 0 };
  obj.priority = priority;
  portfolio.version++;
  return { updated: true, priority: obj.priority };
}

export function evaluatePriority(objective: ObjectiveRef, blockedDuration: number): number {
  let score = objective.priority;
  if (objective.risk === 'critical') score += 50;
  if (objective.risk === 'high') score += 30;
  if (objective.deadline && new Date(objective.deadline).getTime() < Date.now() + 3600000) score += 40;
  score += Math.min(blockedDuration, 100) * 0.1;
  score += objective.age * 0.05;
  return score;
}

export function arbitrate(portfolioId: string): { scheduled: string[]; blocked: string[]; deferred: string[]; reasons: Record<string, string> } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { scheduled: [], blocked: [], deferred: [], reasons: {} };
  const entries = Array.from(portfolio.objectives.values());
  const scheduled: string[] = [];
  const blocked: string[] = [];
  const deferred: string[] = [];
  const reasons: Record<string, string> = {};
  // dependency check
  const ready = new Set<string>(scheduled);
  for (const obj of entries) {
    if (obj.state === 'PAUSED' || obj.state === 'CANCELLED') continue;
    const depsSatisfied = obj.dependencies.every(dep => portfolio.objectives.get(dep)?.state === 'SUCCEEDED');
    if (!depsSatisfied) { blocked.push(obj.objectiveId); reasons[obj.objectiveId] = 'dependencies not satisfied'; continue; }
    // resource check simplified
    // risk check
    if (obj.risk === 'critical' || obj.risk === 'high') { blocked.push(obj.objectiveId); reasons[obj.objectiveId] = 'high/critical risk requires approval'; continue; }
    scheduled.push(obj.objectiveId);
    ready.add(obj.objectiveId);
  }
  return { scheduled, blocked, deferred, reasons };
}

export function detectConflicts(portfolioId: string): { conflicts: { objectiveA: string; objectiveB: string; reason: string }[] } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { conflicts: [] };
  const conflicts: { objectiveA: string; objectiveB: string; reason: string }[] = [];
  const entries = Array.from(portfolio.objectives.values());
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].resourceRequirements.some(r1 => entries[j].resourceRequirements.some(r2 => r1.type === r2.type && r1.amount + r2.amount > 1))) {
        conflicts.push({ objectiveA: entries[i].objectiveId, objectiveB: entries[j].objectiveId, reason: 'resource contention' });
      }
    }
  }
  return { conflicts };
}

export function evaluateRisk(objective: ObjectiveRef, globalBudgetUsed: number): { riskLevel: string; allowed: boolean; riskScore: number } {
  let score = 0;
  if (objective.risk === 'critical') score = 4;
  else if (objective.risk === 'high') score = 3;
  else if (objective.risk === 'medium') score = 2;
  else score = 1;
  return { riskLevel: objective.risk, allowed: score <= 3, riskScore: score };
}

export function evaluateGovernance(riskLevel?: string, freeze?: boolean, deny?: boolean): { decision: string } {
  if (freeze) return { decision: 'FREEZE' };
  if (deny) return { decision: 'DENY' };
  if (riskLevel === 'high' || riskLevel === 'critical') return { decision: 'APPROVAL_REQUIRED' };
  return { decision: 'ALLOW' };
}

export function evaluateSafety(input: any): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.unknownProvider) reasons.push('unknown provider');
  if (input.protectedResource) reasons.push('protected resource');
  if (input.unknownHealth) reasons.push('unknown health');
  if (input.excessiveBlastRadius) reasons.push('excessive blast radius');
  if (input.missingRollback) reasons.push('missing rollback');
  if (input.missingVerification) reasons.push('missing verification');
  if (input.circuitBreakerOpen) reasons.push('circuit breaker open');
  return { safe: reasons.length === 0, reasons };
}

export function evaluateFairness(objective: ObjectiveRef, skippedCycles: number): number {
  return objective.priority + skippedCycles * 10;
}

export function evaluateDeadline(objective: ObjectiveRef): boolean {
  if (!objective.deadline) return false;
  return new Date(objective.deadline).getTime() < Date.now() + 60000;
}

export function staleObjectiveDetection(objective: ObjectiveRef, now: number): boolean {
  return objective.age > 100 && objective.state !== 'PAUSED' && objective.state !== 'CANCELLED';
}

export function scheduleObjectives(portfolioId: string): { scheduled: string[]; blocked: string[]; deferred: string[] } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { scheduled: [], blocked: [], deferred: [] };
  const entries = Array.from(portfolio.objectives.values());
  const scheduled: string[] = [];
  const blocked: string[] = [];
  const deferred: string[] = [];
  for (const obj of entries) {
    if (obj.state === 'PAUSED' || obj.state === 'CANCELLED') { deferred.push(obj.objectiveId); continue; }
    if (obj.risk === 'critical' || obj.risk === 'high') { blocked.push(obj.objectiveId); continue; }
    scheduled.push(obj.objectiveId);
  }
  return { scheduled, blocked, deferred };
}

export function reconcile(portfolioId: string): { cycleId: string; version: number; scheduled: string[]; blocked: string[]; deferred: string[] } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { cycleId: '', version: 0, scheduled: [], blocked: [], deferred: [] };
  portfolio.version++;
  const { scheduled, blocked, deferred } = scheduleObjectives(portfolioId);
  return { cycleId: randomUUID(), version: portfolio.version, scheduled, blocked, deferred };
}

export function detectDrift(portfolioId: string): { drifted: boolean; driftReasons: string[] } {
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) return { drifted: false, driftReasons: [] };
  const last = portfolio.lastDetectedVersion || 0;
  const drifted = portfolio.version !== last;
  portfolio.lastDetectedVersion = portfolio.version;
  return { drifted, driftReasons: drifted ? ['portfolio version changed'] : [] };
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


