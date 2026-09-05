import { createStrategyExecution, transitionExecution, StrategyExecution, StrategyExecutionStatus } from './worker-strategy-execution';
import { createExecutionPlan } from './worker-strategy-execution-plan';
import { evaluateExecutionGate } from './worker-strategy-execution-gate';
import { unavailableExecutionAdapter } from './worker-strategy-execution-adapter';
import { evaluateExecutionHealth } from './worker-strategy-execution-monitor';
import { evaluateOutcome, OutcomeClassification } from './worker-strategy-outcome-evaluator';
import { determineAdaptation } from './worker-strategy-adaptation';
import { detectStrategyDrift } from './worker-strategy-drift';
import { createExecutionMemoryRecord } from './worker-strategy-execution-memory';
import { updateStrategyConfidence } from './worker-strategy-confidence-update';
import { createStrategyAuditEvent } from './worker-optimization-strategy-audit';

export interface ClosedLoopOrchestrationInput {
  tenantId: string;
  strategyId: string;
  strategyVersion: string;
  correlationId: string;
  strategyApproved: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  riskAllowed: boolean;
  constraintsSatisfied: boolean;
  resourceAvailable: boolean;
  conflictingStrategy: boolean;
  rollbackLock: boolean;
  validLineage: boolean;
  requiredVerificationExists: boolean;
  requiredApprovalExists: boolean;
  planSteps: Parameters<typeof createExecutionPlan>[3];
  expectedOutcome: Record<string, number>;
  observedOutcome: Record<string, number>;
  driftInput: Parameters<typeof detectStrategyDrift>[0];
  outcomeInput: Parameters<typeof evaluateOutcome>[0];
  confidenceInput: Parameters<typeof updateStrategyConfidence>[0];
  idempotencyKey?: string;
}

export async function orchestrateClosedLoop(input: ClosedLoopOrchestrationInput) {
  const gate = evaluateExecutionGate({
    strategyExists: true,
    strategyApproved: input.strategyApproved,
    confidenceSufficient: input.confidence !== 'LOW' && input.confidence !== 'UNKNOWN',
    riskAllowed: input.riskAllowed,
    constraintsSatisfied: input.constraintsSatisfied,
    resourceAvailable: input.resourceAvailable,
    noConflictingStrategy: !input.conflictingStrategy,
    noActiveRollbackLock: !input.rollbackLock,
    validLineage: input.validLineage,
    requiredVerificationExists: input.requiredVerificationExists,
    requiredApprovalExists: input.requiredApprovalExists,
    duplicateExecution: false,
  });

  if (gate.decision !== 'ALLOW') {
    return { status: 'BLOCKED', reason: gate.reason, execution: null };
  }

  const execution = createStrategyExecution({
    tenantId: input.tenantId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    actor: 'orchestrator',
    reason: 'closed-loop execution',
    environment: 'test',
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
  });

  const plan = createExecutionPlan(input.strategyId, input.tenantId, input.correlationId, input.planSteps);

  const adapterResults = [];
  for (const step of plan.steps) {
    const result = await unavailableExecutionAdapter.executeAction(step.action, step.parameters);
    adapterResults.push({ stepId: step.stepId, result });
  }

  // Proper lifecycle transitions
  let current = execution;
  try {
    current = transitionExecution(current, 'VALIDATING');
    current = transitionExecution(current, 'APPROVED');
    current = transitionExecution(current, 'RUNNING');
    const allUnavailable = adapterResults.every(r => r.result === 'UNAVAILABLE');
    current = transitionExecution(current, allUnavailable ? 'FAILED' : 'COMPLETED');
  } catch {
    // in case of transition error, current remains at last valid state
  }

  const health = evaluateExecutionHealth({
    expectedOutcome: input.expectedOutcome,
    observedOutcome: input.observedOutcome,
    errorRate: 0,
    resourceUsage: 0,
    budgetConsumption: 0,
    policyViolation: false,
    driftDetected: false,
    unexpectedBehavior: false,
  });

  const drift = detectStrategyDrift(input.driftInput, 'PERFORMANCE');
  const outcome = evaluateOutcome(input.outcomeInput);
  const adaptation = determineAdaptation({
    outcome,
    confidence: input.confidence,
    driftSeverity: drift.severity,
    resourceBudgetExceeded: false,
    safetyViolation: false,
  });
  const newConfidence = updateStrategyConfidence(input.confidenceInput);
  const memory = createExecutionMemoryRecord({
    tenantId: input.tenantId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    executionId: execution.executionId,
    outcome,
    evidence: [],
    environmentalConditions: [],
    adaptations: [adaptation],
    confidence: newConfidence,
    correlationId: input.correlationId,
  });
  const audit = createStrategyAuditEvent({
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    eventType: 'STRATEGY_EXECUTION_COMPLETED',
    reason: `Outcome: ${outcome}, Adaptation: ${adaptation}`,
    decision: adaptation,
  });

  return {
    gate,
    execution: current,
    plan,
    adapterResults,
    health,
    drift,
    outcome,
    adaptation,
    newConfidence,
    memory,
    audit,
  };
}
