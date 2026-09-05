import { createStrategyOutcome } from './worker-strategy-outcome-ingestion';
import { attributeOutcome } from './worker-strategy-outcome-attribution';
import { learnEffectiveness } from './worker-strategy-effectiveness-learning';
import { calibrateConfidence } from './worker-strategy-confidence-calibration';
import { detectStrategyDrift } from './worker-strategy-drift-intelligence';
import { determineSelfCorrection } from './worker-strategy-self-correction';
import { createAdaptationProposal } from './worker-strategy-adaptation-proposal';
import { createFailureMemoryRecord } from './worker-strategy-failure-memory';
import { transferKnowledge } from './worker-strategy-cross-learning';
import { evaluateObjectiveOutcome, detectProxyMismatch } from './worker-strategy-objective-outcome';
import { evaluateRetirementCandidate } from './worker-strategy-retirement';
import { createLearningAuditEvent } from './worker-strategy-learning-audit';

export interface OutcomeOrchestrationInput {
  tenantId: string;
  strategyId: string;
  strategyVersion: string;
  executionId: string;
  correlationId: string;
  outcome: Omit<Parameters<typeof createStrategyOutcome>[0], 'tenantId' | 'strategyId' | 'executionId' | 'correlationId'>;
  attribution: Parameters<typeof attributeOutcome>[0];
  effectiveness: {
    outcomes: Parameters<typeof learnEffectiveness>[1];
  };
  calibration: Parameters<typeof calibrateConfidence>[0];
  drift: Parameters<typeof detectStrategyDrift>[0];
  selfCorrection: Parameters<typeof determineSelfCorrection>[0];
  adaptation?: Omit<Parameters<typeof createAdaptationProposal>[0], 'tenantId' | 'strategyId' | 'correlationId'>;
  failureMemory?: Omit<Parameters<typeof createFailureMemoryRecord>[0], 'tenantId' | 'strategyId' | 'correlationId'>;
  crossLearning?: {
    source: Parameters<typeof transferKnowledge>[0];
    similarityScore: number;
    lineageMatch: boolean;
  };
  objectiveOutcome: {
    intendedObjective: string;
    intendedDelta: number;
    actualIntendedDelta: number;
    proxyMetricDelta: number;
    sideEffectsDetected: boolean;
  };
  retirement: Omit<Parameters<typeof evaluateRetirementCandidate>[0], 'tenantId' | 'strategyId' | 'correlationId'>;
}

export function orchestrateOutcomeIntelligence(input: OutcomeOrchestrationInput) {
  // 1. Ingestion
  const outcome = createStrategyOutcome({
    ...input.outcome,
    tenantId: input.tenantId,
    strategyId: input.strategyId,
    executionId: input.executionId,
    correlationId: input.correlationId,
  });

  // 2. Attribution
  const attribution = attributeOutcome(input.attribution);

  // 3. Effectiveness learning
  const effectiveness = learnEffectiveness(input.strategyId, input.effectiveness.outcomes);

  // 4. Confidence calibration
  const calibration = calibrateConfidence(input.calibration);

  // 5. Drift
  const drift = detectStrategyDrift(input.drift);

  // 6. Self-correction
  const selfCorrection = determineSelfCorrection(input.selfCorrection);

  // 7. Adaptation proposal (optional)
  const adaptation = input.adaptation
    ? createAdaptationProposal({
        ...input.adaptation,
        tenantId: input.tenantId,
        strategyId: input.strategyId,
        correlationId: input.correlationId,
      })
    : null;

  // 8. Failure memory (optional)
  const failureMemory = input.failureMemory
    ? createFailureMemoryRecord({
        ...input.failureMemory,
        tenantId: input.tenantId,
        strategyId: input.strategyId,
        correlationId: input.correlationId,
      })
    : null;

  // 9. Cross-learning (optional)
  const crossLearning = input.crossLearning
    ? transferKnowledge(input.crossLearning.source, input.strategyId, input.crossLearning.similarityScore, input.crossLearning.lineageMatch)
    : null;

  // 10. Objective outcome
  const objectiveOutcome = evaluateObjectiveOutcome(input.objectiveOutcome);
  const proxyMismatch = detectProxyMismatch(input.objectiveOutcome.proxyMetricDelta, input.objectiveOutcome.actualIntendedDelta);

  // 11. Retirement
  const retirement = evaluateRetirementCandidate({
    ...input.retirement,
    tenantId: input.tenantId,
    strategyId: input.strategyId,
    correlationId: input.correlationId,
  });

  // 12. Audit events
  const auditEvents = [
    createLearningAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      eventType: 'OUTCOME_INGESTED',
      reason: `Outcome: ${outcome.outcomeId}`,
      decision: 'RECORDED',
    }),
    createLearningAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      eventType: 'ATTRIBUTION_COMPLETED',
      reason: `Attribution: ${attribution}`,
      decision: attribution,
    }),
    createLearningAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      eventType: 'SELF_CORRECTION_DECISION',
      reason: `Decision: ${selfCorrection}`,
      decision: selfCorrection,
    }),
  ];

  return {
    outcome,
    attribution,
    effectiveness,
    calibration,
    drift,
    selfCorrection,
    adaptation,
    failureMemory,
    crossLearning,
    objectiveOutcome,
    proxyMismatch,
    retirement,
    auditEvents,
  };
}
