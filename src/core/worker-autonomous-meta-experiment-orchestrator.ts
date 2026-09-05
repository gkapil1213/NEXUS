import { createMetaExperimentDefinition, validateMetaExperimentDefinition, MetaExperimentDefinition } from './worker-meta-experiment-definition';
import { selectMetaExperimentCandidates } from './worker-meta-experiment-selection';
import { evaluateMetaFatigue } from './worker-meta-experiment-fatigue';
import { detectMetaStagnation } from './worker-meta-experiment-stagnation';
import { governMetaExperiment } from './worker-meta-experiment-governance';
import { evaluateMetaSafety } from './worker-meta-experiment-safety';
import { checkMetaBudget, MetaBudget } from './worker-meta-experiment-budget';
import { createMetaEvidence } from './worker-meta-experiment-evidence';
import { calculateMetaConfidence } from './worker-meta-experiment-confidence';
import { compareMethods } from './worker-meta-experiment-comparison';
import { evaluateMetaRollout } from './worker-meta-experiment-rollout';
import { evaluateMetaRollback } from './worker-meta-experiment-rollback';
import { createMetaAuditEvent } from './worker-meta-experiment-audit';
import { createMetaLearningRecord } from './worker-meta-experiment-learning';

export interface MetaOrchestrationInput {
  tenantId: string;
  correlationId: string;
  objectiveId: string;
  methodIds: string[];
  hypothesis: string;
  constraints: string[];
  budget: number;
  minimumEvidence: number;
  confidenceThreshold: number;
  methodProfiles: Parameters<typeof selectMetaExperimentCandidates>[0];
  fatigueInput: Parameters<typeof evaluateMetaFatigue>[0];
  stagnationInput: Parameters<typeof detectMetaStagnation>[0];
  governanceInput: Parameters<typeof governMetaExperiment>[0];
  safetyInput: Parameters<typeof evaluateMetaSafety>[0];
  budgetState: MetaBudget;
  currentUsage: Parameters<typeof checkMetaBudget>[1];
  evidenceInput: Omit<Parameters<typeof createMetaEvidence>[0], 'metaExperimentId' | 'correlationId'>[];
  confidenceInput: Parameters<typeof calculateMetaConfidence>[0];
  comparisonMetrics: Parameters<typeof compareMethods>[0];
  rolloutInput: Parameters<typeof evaluateMetaRollout>[0];
  rollbackInput: Parameters<typeof evaluateMetaRollback>[0];
}

export function orchestrateMetaExperiment(input: MetaOrchestrationInput) {
  const auditEvents: ReturnType<typeof createMetaAuditEvent>[] = [];

  const definition = createMetaExperimentDefinition({
    tenantId: input.tenantId,
    objectiveId: input.objectiveId,
    methodIds: input.methodIds,
    hypothesis: input.hypothesis,
    constraints: input.constraints,
    budget: input.budget,
    minimumEvidence: input.minimumEvidence,
    confidenceThreshold: input.confidenceThreshold,
    correlationId: input.correlationId,
  });

  const validation = validateMetaExperimentDefinition(definition);
  if (!validation.valid) {
    return { status: 'INVALID', reason: validation.reason, definition, auditEvents };
  }

  const selected = selectMetaExperimentCandidates(input.methodProfiles, 2);
  const fatigue = evaluateMetaFatigue(input.fatigueInput);
  const stagnation = detectMetaStagnation(input.stagnationInput);
  const governance = governMetaExperiment(input.governanceInput);
  const safety = evaluateMetaSafety(input.safetyInput);
  const budgetCheck = checkMetaBudget(input.budgetState, input.currentUsage);

  if (!budgetCheck.allowed || governance === 'DENY' || safety === 'DENY' || fatigue === 'THROTTLED') {
    auditEvents.push(createMetaAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, metaExperimentId: definition.metaExperimentId, eventType: 'META_EXPERIMENT_REJECTED', reason: `${budgetCheck.reason}, governance=${governance}, safety=${safety}, fatigue=${fatigue}`, decision: 'REJECTED' }));
    return { status: 'REJECTED', reason: `${budgetCheck.reason}, governance=${governance}, safety=${safety}, fatigue=${fatigue}`, definition, auditEvents };
  }

  // Evidence
  const evidenceRecords = input.evidenceInput.map(e => createMetaEvidence({ ...e, metaExperimentId: definition.metaExperimentId, correlationId: input.correlationId }));
  const confidence = calculateMetaConfidence(input.confidenceInput);
  const comparison = compareMethods(input.comparisonMetrics, input.confidenceThreshold);
  const rollout = evaluateMetaRollout(input.rolloutInput);
  const rollback = evaluateMetaRollback(input.rollbackInput);

  const learning = createMetaLearningRecord({
    tenantId: input.tenantId,
    methodId: comparison.winner ?? 'none',
    metaExperimentId: definition.metaExperimentId,
    outcome: comparison.decision,
    evidence: [],
    confidence,
    correlationId: input.correlationId,
  });

  auditEvents.push(createMetaAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, metaExperimentId: definition.metaExperimentId, eventType: 'META_EXPERIMENT_CREATED', reason: 'created', decision: 'CREATED' }));
  auditEvents.push(createMetaAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, metaExperimentId: definition.metaExperimentId, eventType: 'META_EXPERIMENT_COMPLETED', reason: `decision=${comparison.decision}`, decision: comparison.decision }));

  return {
    status: 'COMPLETED',
    definition,
    selected,
    fatigue,
    stagnation,
    governance,
    safety,
    budgetCheck,
    evidenceRecords,
    confidence,
    comparison,
    rollout,
    rollback,
    learning,
    auditEvents,
  };
}
