import { randomUUID } from 'crypto';
import { createExecutionPlan } from './worker-optimization-portfolio-execution-plan';
import { evaluateExecutionGate } from './worker-optimization-portfolio-execution-gate';
import { createExecutionCycle, transitionExecutionCycle, ExecutionCycle, ExecutionStatus } from './worker-optimization-portfolio-executor';
import { createExecutionBudget, reserveBudget, consumeBudget } from './worker-optimization-portfolio-execution-budget';
import { evaluateExecutionRisk } from './worker-optimization-portfolio-execution-risk';
import { evaluateExecutionMonitor } from './worker-optimization-portfolio-execution-monitor';
import { createExecutionOutcome } from './worker-optimization-portfolio-execution-outcome';
import { attributeOutcome } from './worker-optimization-portfolio-outcome-attribution';
import { proposeReallocation } from './worker-optimization-portfolio-reallocation';
import { evaluateAdaptationGate } from './worker-optimization-portfolio-adaptation-gate';
import { detectDrift } from './worker-optimization-portfolio-drift';
import { detectDegradation } from './worker-optimization-portfolio-degradation';
import { decideRecoveryAction } from './worker-optimization-portfolio-execution-recovery';
import { evaluateExecutionRollback } from './worker-optimization-portfolio-execution-rollback';
import { governExecution } from './worker-optimization-portfolio-execution-governance';
import { evaluateExecutionSafety } from './worker-optimization-portfolio-execution-safety';
import { addExecutionLineageNode, ExecutionLineage } from './worker-optimization-portfolio-execution-lineage';
import { createExecutionLearningRecord } from './worker-optimization-portfolio-execution-learning';
import { createExecutionAuditEvent } from './worker-optimization-portfolio-execution-audit';

export interface ControlCycleSnapshot {
  cycleId: string;
  requestId: string;
  objectiveId: string;
  strategyContext: string;
  populationContext: string;
  experimentContext: string;
  metaExperimentContext: string;
  portfolioContext: string;
  executionContext: string;
  outcomeContext?: string;
  learningContext?: string;
  lineageContext?: string;
  governanceContext: string;
  safetyContext: string;
  version: number;
  fingerprint: string;
  createdAt: string;
}

export interface ControlPlaneRequest {
  requestId: string;
  objectiveId: string;
  strategyContext: string;
  populationContext: string;
  experimentContext: string;
  metaExperimentContext: string;
  portfolioContext: string;
  executionContext: string;
  planSteps: Parameters<typeof createExecutionPlan>[0]['steps'];
  gateInput: Parameters<typeof evaluateExecutionGate>[0];
  budgetTotal: number;
  reserveAmount: number;
  consumeAmount: number;
  riskInput: Parameters<typeof evaluateExecutionRisk>[0];
  monitorInput: Parameters<typeof evaluateExecutionMonitor>[0];
  outcomeInput: Omit<Parameters<typeof createExecutionOutcome>[0], 'executionId' | 'portfolioId' | 'correlationId'>;
  attributionInput: Parameters<typeof attributeOutcome>[0];
  reallocationInput: Parameters<typeof proposeReallocation>[0];
  adaptationGateInput: Parameters<typeof evaluateAdaptationGate>[0];
  driftInput: Parameters<typeof detectDrift>[0];
  degradationInput: Parameters<typeof detectDegradation>[0];
  recoveryInput: Parameters<typeof decideRecoveryAction>[0];
  rollbackInput: Parameters<typeof evaluateExecutionRollback>[0];
  governanceInput: Parameters<typeof governExecution>[0];
  safetyInput: Parameters<typeof evaluateExecutionSafety>[0];
  tenantId: string;
  correlationId: string;
  idempotencyKey?: string;
}

export interface ControlCycleResult {
  cycleId: string;
  status: 'COMPLETED' | 'BLOCKED' | 'REJECTED' | 'FAILED';
  reason?: string;
  snapshot: ControlCycleSnapshot;
  plan?: ReturnType<typeof createExecutionPlan>;
  execution?: ExecutionCycle;
  outcome?: ReturnType<typeof createExecutionOutcome>;
  attribution?: ReturnType<typeof attributeOutcome>;
  monitor?: ReturnType<typeof evaluateExecutionMonitor>;
  drift?: ReturnType<typeof detectDrift>;
  degradation?: ReturnType<typeof detectDegradation>;
  reallocation?: ReturnType<typeof proposeReallocation>;
  adaptation?: ReturnType<typeof evaluateAdaptationGate>;
  recovery?: ReturnType<typeof decideRecoveryAction>;
  rollback?: ReturnType<typeof evaluateExecutionRollback>;
  learning?: ReturnType<typeof createExecutionLearningRecord>;
  lineage?: ExecutionLineage;
  auditEvents: ReturnType<typeof createExecutionAuditEvent>[];
}

export function createControlCycle(request: ControlPlaneRequest): ControlCycleResult {
  const cycleId = randomUUID();
  const idempotencyKey = request.idempotencyKey ?? `${request.requestId}:${request.objectiveId}:${request.correlationId}`;
  const fingerprint = `${request.requestId}:${request.objectiveId}:${request.strategyContext}:${request.portfolioContext}:${request.executionContext}:${request.correlationId}`;
  const snapshot: ControlCycleSnapshot = {
    cycleId,
    requestId: request.requestId,
    objectiveId: request.objectiveId,
    strategyContext: request.strategyContext,
    populationContext: request.populationContext,
    experimentContext: request.experimentContext,
    metaExperimentContext: request.metaExperimentContext,
    portfolioContext: request.portfolioContext,
    executionContext: request.executionContext,
    governanceContext: 'pending',
    safetyContext: 'pending',
    version: 1,
    fingerprint,
    createdAt: new Date().toISOString(),
  };
  return {
    cycleId,
    status: 'FAILED', // will be overwritten
    snapshot,
    auditEvents: [],
  };
}

export function runControlCycle(request: ControlPlaneRequest): ControlCycleResult {
  const auditEvents: ReturnType<typeof createExecutionAuditEvent>[] = [];
  const base = createControlCycle(request);
  const snapshot = base.snapshot;

  // 1. Objective consistency (already implicit; we can check simple string non-empty)
  if (!request.objectiveId || !request.strategyContext || !request.portfolioContext) {
    auditEvents.push(createExecutionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, portfolioId: request.portfolioContext, eventType: 'CONTROL_PLANE_REJECTED', reason: 'missing required context', decision: 'REJECTED' }));
    return { ...base, status: 'REJECTED', reason: 'missing required context', auditEvents };
  }

  // 2. Gate check
  const gate = evaluateExecutionGate(request.gateInput);
  if (gate.decision !== 'ALLOW') {
    auditEvents.push(createExecutionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, portfolioId: request.portfolioContext, eventType: 'CONTROL_PLANE_BLOCKED', reason: gate.reason, decision: 'BLOCKED' }));
    return { ...base, status: 'BLOCKED', reason: gate.reason, auditEvents };
  }

  // 3. Governance & Safety
  const governance = governExecution(request.governanceInput);
  const safety = evaluateExecutionSafety(request.safetyInput);
  if (governance === 'DENIED' || !safety.allowed) {
    auditEvents.push(createExecutionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, portfolioId: request.portfolioContext, eventType: 'CONTROL_PLANE_REJECTED', reason: `governance=${governance}, safety=${safety.allowed}`, decision: 'REJECTED' }));
    return { ...base, status: 'REJECTED', reason: `governance=${governance}, safety=${safety.allowed}`, auditEvents };
  }

  // 4. Budget
  let budget = createExecutionBudget(request.portfolioContext, request.budgetTotal);
  const reserveResult = reserveBudget(budget, request.reserveAmount);
  if (!reserveResult.success) {
    return { ...base, status: 'FAILED', reason: reserveResult.reason, auditEvents };
  }
  budget = reserveResult.budget;
  const consumeResult = consumeBudget(budget, request.consumeAmount);
  if (!consumeResult.success) {
    return { ...base, status: 'FAILED', reason: consumeResult.reason, auditEvents };
  }

  // 5. Plan & Execution cycle
  const plan = createExecutionPlan({
    portfolioId: request.portfolioContext,
    version: 1,
    steps: request.planSteps,
    correlationId: request.correlationId,
  });
  let cycle = createExecutionCycle({
    portfolioId: request.portfolioContext,
    planId: plan.planId,
    correlationId: request.correlationId,
  });
  try {
    cycle = transitionExecutionCycle(cycle, 'VALIDATING');
    cycle = transitionExecutionCycle(cycle, 'APPROVED');
    cycle = transitionExecutionCycle(cycle, 'RUNNING');
    cycle = transitionExecutionCycle(cycle, 'SUCCEEDED');
  } catch {
    cycle = transitionExecutionCycle(cycle, 'FAILED');
    return { ...base, status: 'FAILED', reason: 'illegal transition', execution: cycle, plan, auditEvents };
  }

  // 6. Outcome & attribution
  const outcome = createExecutionOutcome({
    ...request.outcomeInput,
    executionId: cycle.executionId,
    portfolioId: request.portfolioContext,
    correlationId: request.correlationId,
  });
  const attribution = attributeOutcome(request.attributionInput);

  // 7. Monitoring
  const monitor = evaluateExecutionMonitor(request.monitorInput);

  // 8. Drift / Degradation
  const drift = detectDrift(request.driftInput);
  const degradation = detectDegradation(request.degradationInput);

  // 9. Reallocation / Adaptation
  const reallocation = proposeReallocation(request.reallocationInput);
  const adaptation = evaluateAdaptationGate(request.adaptationGateInput);

  // 10. Recovery / Rollback
  const recovery = decideRecoveryAction(request.recoveryInput);
  const rollback = evaluateExecutionRollback(request.rollbackInput);

  // 11. Learning
  const learning = createExecutionLearningRecord({
    tenantId: request.tenantId,
    portfolioId: request.portfolioContext,
    executionId: cycle.executionId,
    outcome: outcome.result,
    evidence: outcome.evidence,
    confidence: attribution.confidence,
    correlationId: request.correlationId,
  });

  // 12. Lineage
  const lineage: ExecutionLineage = { portfolioId: request.portfolioContext, nodes: [] };
  const lineageWithNode = addExecutionLineageNode(lineage, {
    version: 1,
    portfolioVersion: 1,
    strategyId: request.outcomeInput.strategyId,
    strategyGenerationId: request.outcomeInput.strategyGenerationId,
    populationId: request.populationContext,
    planId: plan.planId,
    executionId: cycle.executionId,
    outcomeId: outcome.outcomeId,
    reason: 'control plane cycle',
    timestamp: new Date().toISOString(),
  });

  // 13. Audit
  auditEvents.push(createExecutionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, portfolioId: request.portfolioContext, executionId: cycle.executionId, eventType: 'CONTROL_PLANE_COMPLETED', reason: `outcome=${outcome.result}`, decision: 'COMPLETED' }));

  return {
    ...base,
    status: 'COMPLETED',
    snapshot,
    plan,
    execution: cycle,
    outcome,
    attribution,
    monitor,
    drift,
    degradation,
    reallocation,
    adaptation,
    recovery,
    rollback,
    learning,
    lineage: lineageWithNode,
    auditEvents,
  };
}
