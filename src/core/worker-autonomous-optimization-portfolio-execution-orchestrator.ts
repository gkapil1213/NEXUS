import { createExecutionPlan, ExecutionPlan } from './worker-optimization-portfolio-execution-plan';
import { evaluateExecutionGate } from './worker-optimization-portfolio-execution-gate';
import { createExecutionCycle, transitionExecutionCycle, ExecutionCycle, ExecutionStatus } from './worker-optimization-portfolio-executor';
import { createExecutionBudget, reserveBudget, consumeBudget, ExecutionBudget } from './worker-optimization-portfolio-execution-budget';
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

export interface PortfolioExecutionOrchestrationInput {
  tenantId: string;
  correlationId: string;
  portfolioId: string;
  portfolioVersion: number;
  planSteps: Parameters<typeof createExecutionPlan>[0]['steps'];
  gateInput: Parameters<typeof evaluateExecutionGate>[0];
  budgetTotal: number;
  budgetReserveAmount: number;
  budgetConsumeAmount: number;
  riskInput: Parameters<typeof evaluateExecutionRisk>[0];
  monitorInput: Parameters<typeof evaluateExecutionMonitor>[0];
  outcomeInput: Omit<Parameters<typeof createExecutionOutcome>[0], 'executionId' | 'portfolioId' | 'portfolioVersion' | 'correlationId'>;
  attributionInput: Parameters<typeof attributeOutcome>[0];
  reallocationInput: Parameters<typeof proposeReallocation>[0];
  adaptationGateInput: Parameters<typeof evaluateAdaptationGate>[0];
  driftInput: Parameters<typeof detectDrift>[0];
  degradationInput: Parameters<typeof detectDegradation>[0];
  recoveryInput: Parameters<typeof decideRecoveryAction>[0];
  rollbackInput: Parameters<typeof evaluateExecutionRollback>[0];
  governanceInput: Parameters<typeof governExecution>[0];
  safetyInput: Parameters<typeof evaluateExecutionSafety>[0];
  lineage?: ExecutionLineage;
}

export function orchestratePortfolioExecution(input: PortfolioExecutionOrchestrationInput) {
  const auditEvents: ReturnType<typeof createExecutionAuditEvent>[] = [];

  // Gate
  const gate = evaluateExecutionGate(input.gateInput);
  if (gate.decision !== 'ALLOW') {
    auditEvents.push(createExecutionAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: input.portfolioId, eventType: 'EXECUTION_BLOCKED', reason: gate.reason, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: gate.reason, auditEvents };
  }

  // Plan
  const plan = createExecutionPlan({
    portfolioId: input.portfolioId,
    version: input.portfolioVersion,
    steps: input.planSteps,
    correlationId: input.correlationId,
  });

  // Execution cycle
  let cycle = createExecutionCycle({
    portfolioId: input.portfolioId,
    planId: plan.planId,
    correlationId: input.correlationId,
  });

  cycle = transitionExecutionCycle(cycle, 'VALIDATING');
  cycle = transitionExecutionCycle(cycle, 'APPROVED');
  cycle = transitionExecutionCycle(cycle, 'RUNNING');

  // Budget
  let budget = createExecutionBudget(input.portfolioId, input.budgetTotal);
  const reserveResult = reserveBudget(budget, input.budgetReserveAmount);
  if (!reserveResult.success) {
    cycle = transitionExecutionCycle(cycle, 'FAILED');
    auditEvents.push(createExecutionAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: input.portfolioId, executionId: cycle.executionId, eventType: 'EXECUTION_FAILED', reason: reserveResult.reason, decision: 'FAILED' }));
    return { status: 'FAILED', reason: reserveResult.reason, cycle, auditEvents };
  }
  budget = reserveResult.budget;
  const consumeResult = consumeBudget(budget, input.budgetConsumeAmount);
  if (!consumeResult.success) {
    cycle = transitionExecutionCycle(cycle, 'FAILED');
    return { status: 'FAILED', reason: consumeResult.reason, cycle, auditEvents };
  }
  budget = consumeResult.budget;

  // Risk and safety/governance
  const risk = evaluateExecutionRisk(input.riskInput);
  const safety = evaluateExecutionSafety(input.safetyInput);
  const governance = governExecution(input.governanceInput);

  if (!risk.allowed || !safety.allowed || governance === 'DENIED') {
    cycle = transitionExecutionCycle(cycle, 'FAILED');
    auditEvents.push(createExecutionAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: input.portfolioId, executionId: cycle.executionId, eventType: 'EXECUTION_REJECTED', reason: `risk=${risk.allowed}, safety=${safety.allowed}, governance=${governance}`, decision: 'REJECTED' }));
    return { status: 'REJECTED', reason: 'risk/safety/governance block', cycle, auditEvents };
  }

  // Simulated execution success
  cycle = transitionExecutionCycle(cycle, 'SUCCEEDED');

  // Outcome
  const outcome = createExecutionOutcome({
    ...input.outcomeInput,
    executionId: cycle.executionId,
    portfolioId: input.portfolioId,
    portfolioVersion: input.portfolioVersion,
    correlationId: input.correlationId,
  });

  // Attribution
  const attribution = attributeOutcome(input.attributionInput);

  // Monitor
  const monitor = evaluateExecutionMonitor(input.monitorInput);
  if (!monitor.healthy) {
    auditEvents.push(createExecutionAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: input.portfolioId, executionId: cycle.executionId, eventType: 'EXECUTION_UNHEALTHY', reason: monitor.reason, decision: 'UNHEALTHY' }));
  }

  // Drift/Degradation
  const drift = detectDrift(input.driftInput);
  const degradation = detectDegradation(input.degradationInput);

  // Reallocation and adaptation
  const reallocation = proposeReallocation(input.reallocationInput);
  const adaptation = evaluateAdaptationGate(input.adaptationGateInput);

  // Recovery and rollback
  const recovery = decideRecoveryAction(input.recoveryInput);
  const rollback = evaluateExecutionRollback(input.rollbackInput);

  // Learning
  const learning = createExecutionLearningRecord({
    tenantId: input.tenantId,
    portfolioId: input.portfolioId,
    executionId: cycle.executionId,
    outcome: outcome.result,
    evidence: outcome.evidence,
    confidence: attribution.confidence,
    correlationId: input.correlationId,
  });

  // Lineage
  const lineageBase: ExecutionLineage = input.lineage ?? { portfolioId: input.portfolioId, nodes: [] };
  const lineage = addExecutionLineageNode(lineageBase, {
    version: input.portfolioVersion + 1,
    portfolioVersion: input.portfolioVersion,
    strategyId: input.outcomeInput.strategyId,
    strategyGenerationId: input.outcomeInput.strategyGenerationId,
    populationId: 'pop-default',
    planId: plan.planId,
    executionId: cycle.executionId,
    outcomeId: outcome.outcomeId,
    reason: 'execution completed',
    timestamp: new Date().toISOString(),
  });

  // Audit final
  auditEvents.push(createExecutionAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, portfolioId: input.portfolioId, executionId: cycle.executionId, eventType: 'EXECUTION_COMPLETED', reason: `outcome=${outcome.result}`, decision: 'COMPLETED' }));

  return {
    status: 'COMPLETED',
    cycle,
    plan,
    budget,
    risk,
    safety,
    governance,
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
    lineage,
    auditEvents,
  };
}
