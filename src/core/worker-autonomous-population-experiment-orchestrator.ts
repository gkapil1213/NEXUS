import { createPopulationExperimentDefinition, validateExperimentDefinition, PopulationExperimentDefinition, ExperimentStatus } from './worker-population-experiment-definition';
import { selectExperimentCandidates } from './worker-population-experiment-selection';
import { decideExplorationMode } from './worker-population-exploration-controller';
import { evaluateExperimentBudget, consumeBudget, ExperimentBudgetState } from './worker-population-experiment-budget';
import { checkConcurrency } from './worker-population-experiment-concurrency';
import { createExperimentEvidence, classifyEvidence } from './worker-population-experiment-evidence';
import { calculateExperimentConfidence } from './worker-population-experiment-confidence';
import { calculateAdaptiveEvidenceThreshold } from './worker-population-experiment-adaptive-threshold';
import { makeExperimentDecision } from './worker-population-experiment-decision';
import { evaluateChampionChallengerExperiment } from './worker-population-champion-challenger-experiment';
import { evaluateMultiStrategyExperiment } from './worker-population-multi-strategy-experiment';
import { createCrossLineageExperimentRecord } from './worker-population-cross-lineage-experiment';
import { createExperimentOutcome, attributeExperimentOutcome } from './worker-population-experiment-outcome';
import { evaluateExperimentFatigue } from './worker-population-experiment-fatigue';
import { decideRecoveryAction } from './worker-population-experiment-recovery';
import { evaluateExperimentRollback } from './worker-population-experiment-rollback';
import { createExperimentAuditEvent } from './worker-population-experiment-audit';

export interface PopulationExperimentOrchestrationInput {
  tenantId: string;
  correlationId: string;
  populationId: string;
  populationVersion: number;
  candidateProfiles: Parameters<typeof selectExperimentCandidates>[0]['candidates'];
  experimentDefinition: Omit<Parameters<typeof createPopulationExperimentDefinition>[0], 'populationId' | 'populationVersion' | 'correlationId'>;
  budget: ExperimentBudgetState;
  requestedBudget: Partial<ExperimentBudgetState>;
  concurrency: Parameters<typeof checkConcurrency>[1];
  concurrencyLimits: Parameters<typeof checkConcurrency>[0];
  strategyId: string;
  lineageId: string;
  explorationInput: Parameters<typeof decideExplorationMode>[0];
  fatigueInput: Parameters<typeof evaluateExperimentFatigue>[0];
  confidenceInput: Parameters<typeof calculateExperimentConfidence>[0];
  evidence: Omit<Parameters<typeof createExperimentEvidence>[0], 'experimentId' | 'strategyId' | 'generationId' | 'lineageId' | 'correlationId'>;
  outcomeAttribution: {
    treatmentDelta: number;
    baselineVariance: number;
    confidence: number;
    concurrentChanges: boolean;
  };
  multiStrategyInput: Parameters<typeof evaluateMultiStrategyExperiment>[0];
  championChallengerInput: Parameters<typeof evaluateChampionChallengerExperiment>[0];
  rollbackInput: Parameters<typeof evaluateExperimentRollback>[0];
}

export function orchestratePopulationExperiment(input: PopulationExperimentOrchestrationInput) {
  const auditEvents: ReturnType<typeof createExperimentAuditEvent>[] = [];

  // 1. Validate definition
  const definition = createPopulationExperimentDefinition({
    ...input.experimentDefinition,
    populationId: input.populationId,
    populationVersion: input.populationVersion,
    correlationId: input.correlationId,
  });
  const validation = validateExperimentDefinition(definition);
  if (!validation.valid) {
    return { status: 'INVALID', reason: validation.reason, definition, auditEvents };
  }

  // 2. Candidate selection
  const selectedCandidates = selectExperimentCandidates({
    candidates: input.candidateProfiles,
    budgetRemaining: input.budget.executionBudget,
    maxCandidates: 1,
    fatigueScore: evaluateExperimentFatigue(input.fatigueInput) === 'THROTTLED' ? 1 : 0,
  });

  // 3. Exploration mode
  const explorationMode = decideExplorationMode(input.explorationInput);

  // 4. Budget check
  const budgetCheck = evaluateExperimentBudget({
    budget: input.budget,
    requested: input.requestedBudget,
    safetyHealthy: input.explorationInput.safetyHealthy,
    governanceAllowed: true,
    populationStable: true,
  });
  if (!budgetCheck.allowed) {
    auditEvents.push(createExperimentAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, experimentId: definition.experimentId, populationId: input.populationId, populationVersion: input.populationVersion, eventType: 'EXPERIMENT_REJECTED', reason: budgetCheck.reason, decision: 'REJECTED' }));
    return { status: 'REJECTED', reason: budgetCheck.reason, definition, explorationMode, auditEvents };
  }

  // 5. Concurrency
  const concurrencyCheck = checkConcurrency(input.concurrencyLimits, input.concurrency, input.strategyId, input.lineageId);
  if (!concurrencyCheck.allowed) {
    auditEvents.push(createExperimentAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, experimentId: definition.experimentId, populationId: input.populationId, populationVersion: input.populationVersion, eventType: 'EXPERIMENT_REJECTED', reason: concurrencyCheck.reason, decision: 'REJECTED' }));
    return { status: 'REJECTED', reason: concurrencyCheck.reason, definition, explorationMode, auditEvents };
  }

  // 6. Evidence
  const evidence = createExperimentEvidence({
    ...input.evidence,
    experimentId: definition.experimentId,
    strategyId: input.strategyId,
    generationId: 'unknown',
    lineageId: input.lineageId,
    correlationId: input.correlationId,
  });

  // 7. Confidence
  const confidence = calculateExperimentConfidence(input.confidenceInput);

  // 8. Adaptive threshold
  const threshold = calculateAdaptiveEvidenceThreshold({
    baseThreshold: 0.5,
    riskLevel: 'LOW',
    championStatus: false,
    rolloutScope: 'SHADOW',
    historicalFailureCount: 0,
    populationImportance: 'MEDIUM',
  });

  // 9. Decision
  const decision = makeExperimentDecision({
    confidence,
    evidenceLevel: classifyEvidence(evidence.sampleSize, evidence.confidence, evidence.durability, false),
    regression: false,
    safetyAllowed: true,
    governanceAllowed: true,
    budgetExceeded: false,
    fatigueExcessive: evaluateExperimentFatigue(input.fatigueInput) === 'THROTTLED',
  });

  // 10. Champion/challenger and multi-strategy evaluation
  const championDecision = evaluateChampionChallengerExperiment(input.championChallengerInput);
  const multiStrategyResult = evaluateMultiStrategyExperiment(input.multiStrategyInput);

  // 11. Cross-lineage record (if applicable)
  const crossLineage = createCrossLineageExperimentRecord({
    experimentId: definition.experimentId,
    populationId: input.populationId,
    populationVersion: input.populationVersion,
    parentLineageIds: [],
    participatingLineageIds: [input.lineageId],
    sharedTraits: [],
    successfulTraits: [],
    failedTraits: [],
    transferableEvidence: [],
    incompatibleTraits: [],
    correlationId: input.correlationId,
  });

  // 12. Outcome attribution
  const attribution = attributeExperimentOutcome(
    input.outcomeAttribution.treatmentDelta,
    input.outcomeAttribution.baselineVariance,
    input.outcomeAttribution.confidence,
    input.outcomeAttribution.concurrentChanges
  );

  // 13. Rollback
  const rollback = evaluateExperimentRollback(input.rollbackInput);

  // 14. Audit events
  auditEvents.push(createExperimentAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, experimentId: definition.experimentId, populationId: input.populationId, populationVersion: input.populationVersion, eventType: 'EXPERIMENT_CREATED', reason: 'created', decision: definition.status }));
  auditEvents.push(createExperimentAuditEvent({ tenantId: input.tenantId, correlationId: input.correlationId, experimentId: definition.experimentId, populationId: input.populationId, populationVersion: input.populationVersion, eventType: 'EXPERIMENT_DECISION', reason: `Decision ${decision}`, decision }));

  return {
    status: 'COMPLETED',
    definition,
    selectedCandidates,
    explorationMode,
    budgetCheck,
    concurrencyCheck,
    evidence,
    confidence,
    threshold,
    decision,
    championDecision,
    multiStrategyResult,
    crossLineage,
    attribution,
    rollback,
    auditEvents,
  };
}
