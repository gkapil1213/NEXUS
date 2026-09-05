import { createOptimizationMemoryRecord } from './worker-optimization-long-horizon-memory';
import { classifyTemporalOutcome } from './worker-optimization-temporal-intelligence';
import { evaluateDurability } from './worker-optimization-durability';
import { evaluateReturnAnalysis } from './worker-optimization-return-analysis';
import { evaluateOptimizationFatigue } from './worker-optimization-fatigue';
import { classifyStrategyInteraction } from './worker-optimization-interaction-intelligence';
import { retrieveHistoricalEvidence } from './worker-optimization-historical-memory';
import { shouldBlockRepeatedFailure } from './worker-optimization-failure-memory';
import { makeLongHorizonDecision } from './worker-optimization-long-horizon-decision';
import { createOptimizationRecommendation } from './worker-optimization-recommendation';
import { createPortfolioAuditEvent } from './worker-optimization-portfolio-audit';

export interface LongHorizonOrchestrationInput {
  tenantId: string;
  correlationId: string;
  temporalObservations: Parameters<typeof classifyTemporalOutcome>[0]['observations'];
  durabilityInput: Parameters<typeof evaluateDurability>[0];
  returnInput: Parameters<typeof evaluateReturnAnalysis>[0];
  fatigueInput: Parameters<typeof evaluateOptimizationFatigue>[0];
  interactionInput: Parameters<typeof classifyStrategyInteraction>[0];
  historicalMemory: Parameters<typeof retrieveHistoricalEvidence>[1];
  failureMemory: Parameters<typeof shouldBlockRepeatedFailure>[0][]; // array of failure records
  decisionInput: Parameters<typeof makeLongHorizonDecision>[0];
  recommendationInput: Omit<Parameters<typeof createOptimizationRecommendation>[0], 'tenantId'>;
  resourceBudgetExceeded: boolean;
  staleTelemetry: boolean;
}

export function orchestrateLongHorizonOptimization(input: LongHorizonOrchestrationInput) {
  // 1. Temporal classification
  const temporalClassification = classifyTemporalOutcome({ observations: input.temporalObservations });

  // 2. Durability
  const durability = evaluateDurability(input.durabilityInput);

  // 3. Return analysis
  const returnAnalysis = evaluateReturnAnalysis(input.returnInput);

  // 4. Fatigue
  const fatigue = evaluateOptimizationFatigue(input.fatigueInput);

  // 5. Interaction (if present)
  const interaction = classifyStrategyInteraction(input.interactionInput);

  // 6. Historical evidence retrieval (simplified: we pass input that matches; in real use, filter)
  const historicalEvidence = retrieveHistoricalEvidence({
    tenantId: input.tenantId,
    objective: input.recommendationInput.affectedObjective,
    scope: 'fleet',
    environment: 'production',
    policyVersion: 'current',
  }, input.historicalMemory);

  // 7. Failure memory check (if any matching failures)
  const knownFailure = input.failureMemory.length > 0;
  const blockRepeated = knownFailure && input.failureMemory.some(f => shouldBlockRepeatedFailure(f, 'production', 'current', 'normal'));

  // 8. Decision
  const decision = makeLongHorizonDecision(input.decisionInput);

  // 9. Recommendation
  const recommendation = createOptimizationRecommendation(
    { ...input.recommendationInput, tenantId: input.tenantId },
    input.correlationId
  );

  // 10. Audit events
  const auditEvents = [
    createPortfolioAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      entityId: 'long-horizon',
      entityVersion: '1',
      eventType: 'TEMPORAL_ANALYSIS_COMPLETED',
      reason: `Temporal classification: ${temporalClassification}`,
      decision: temporalClassification,
    }),
    createPortfolioAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      entityId: 'long-horizon',
      entityVersion: '1',
      eventType: 'DURABILITY_CLASSIFIED',
      reason: `Durability: ${durability}`,
      decision: durability,
    }),
    createPortfolioAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      entityId: 'long-horizon',
      entityVersion: '1',
      eventType: 'RECOMMENDATION_CREATED',
      reason: recommendation.reason,
      decision: recommendation.recommendationType,
    }),
    createPortfolioAuditEvent({
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      entityId: 'long-horizon',
      entityVersion: '1',
      eventType: 'DECISION_CLOSED',
      reason: `Decision: ${decision}`,
      decision,
    }),
  ];

  return {
    temporalClassification,
    durability,
    returnAnalysis,
    fatigue,
    interaction,
    historicalEvidence,
    blockRepeated,
    decision,
    recommendation,
    auditEvents,
  };
}
