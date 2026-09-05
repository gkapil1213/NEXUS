import { createOptimizationMemoryRecord } from '../src/core/worker-optimization-long-horizon-memory';
import { classifyTemporalOutcome } from '../src/core/worker-optimization-temporal-intelligence';
import { evaluateDurability } from '../src/core/worker-optimization-durability';
import { evaluateReturnAnalysis } from '../src/core/worker-optimization-return-analysis';
import { evaluateOptimizationFatigue } from '../src/core/worker-optimization-fatigue';
import { classifyStrategyInteraction } from '../src/core/worker-optimization-interaction-intelligence';
import { retrieveHistoricalEvidence, HistoricalEvidence } from '../src/core/worker-optimization-historical-memory';
import { createFailureMemoryRecord, shouldBlockRepeatedFailure } from '../src/core/worker-optimization-failure-memory';
import { makeLongHorizonDecision } from '../src/core/worker-optimization-long-horizon-decision';
import { createOptimizationRecommendation } from '../src/core/worker-optimization-recommendation';
import { orchestrateLongHorizonOptimization } from '../src/core/worker-autonomous-long-horizon-orchestrator';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.error(`FAIL: ${name}`);
    failed++;
  }
}

function main() {
  console.log('=== Phase 17.32: Autonomous Long-Horizon Optimization Intelligence and Governed Portfolio Control ===');

  // 1. Memory
  const memoryRecord = createOptimizationMemoryRecord({
    tenantId: 'tenantA', optimizationId: 'opt1', portfolioId: 'port1', candidateId: 'cand1',
    policyVersion: 'v1', objective: 'COST', baseline: { cost: 100 }, treatment: { cost: 90 },
    observedResult: { cost: 88 }, confidence: 'HIGH', durationHours: 200, environment: 'production',
    scope: 'fleet', resourceCost: 5, risk: 'LOW', rollbackHistory: [], evidenceReferences: ['ev1'],
    causalConfidence: 'HIGH', status: 'SUCCESS', correlationId: 'corr1'
  });
  assert(memoryRecord.memoryId.length > 0, 'Memory record created');
  assert(memoryRecord.status === 'SUCCESS', 'Memory status success');
  const duplicateMemory = createOptimizationMemoryRecord({
    tenantId: 'tenantA', optimizationId: 'opt1', portfolioId: 'port1', candidateId: 'cand1',
    policyVersion: 'v1', objective: 'COST', baseline: { cost: 100 }, treatment: { cost: 90 },
    observedResult: { cost: 88 }, confidence: 'HIGH', durationHours: 200, environment: 'production',
    scope: 'fleet', resourceCost: 5, risk: 'LOW', rollbackHistory: [], evidenceReferences: ['ev1'],
    causalConfidence: 'HIGH', status: 'SUCCESS', correlationId: 'corr1'
  });
  assert(duplicateMemory.idempotencyKey === memoryRecord.idempotencyKey, 'Duplicate memory same idempotency key');

  // 2. Temporal (positive delta = improvement)
  const temporalObservations = [
    { window: 'IMMEDIATE', metricDelta: { performance: 0.1 }, sampleSize: 50, freshness: 'FRESH' },
    { window: 'SHORT_TERM', metricDelta: { performance: 0.08 }, sampleSize: 60, freshness: 'FRESH' },
    { window: 'MEDIUM_TERM', metricDelta: { performance: 0.06 }, sampleSize: 70, freshness: 'FRESH' },
    { window: 'LONG_TERM', metricDelta: { performance: 0.05 }, sampleSize: 80, freshness: 'FRESH' },
  ];
  assert(classifyTemporalOutcome({ observations: temporalObservations }) === 'PERSISTENT_IMPROVEMENT', 'Persistent improvement detected');
  const transientObservations = [
    { window: 'IMMEDIATE', metricDelta: { performance: 0.1 }, sampleSize: 50, freshness: 'FRESH' },
    { window: 'SHORT_TERM', metricDelta: { performance: 0.0 }, sampleSize: 60, freshness: 'FRESH' },
  ];
  assert(classifyTemporalOutcome({ observations: transientObservations }) === 'SHORT_LIVED_IMPROVEMENT', 'Transient improvement detected');
  assert(classifyTemporalOutcome({ observations: [{ window: 'IMMEDIATE', metricDelta: { performance: 0.1 }, sampleSize: 5, freshness: 'FRESH' }] }) === 'INSUFFICIENT_DATA', 'Insufficient data temporal');

  // 3. Durability (positive delta = improvement)
  const durableInput = {
    baseline: { reliability: 0.9 },
    postChangeObservations: [{ reliability: 0.95 }, { reliability: 0.96 }, { reliability: 0.97 }, { reliability: 0.98 }],
    variance: 0.1, confidence: 'HIGH', durationHours: 200, repeatedObservations: 10,
    concurrentChanges: [], rollbackEvents: 0, telemetryFresh: true
  };
  assert(evaluateDurability(durableInput) === 'DURABLE_IMPROVEMENT', 'Durable improvement');
  const transientDurability = { ...durableInput, durationHours: 10, repeatedObservations: 4 };
  assert(evaluateDurability(transientDurability) === 'TRANSIENT_IMPROVEMENT', 'Transient improvement durability');
  const regressionDurability = { ...durableInput, postChangeObservations: [{ reliability: 0.85 }, { reliability: 0.84 }], durationHours: 200, repeatedObservations: 10 };
  assert(evaluateDurability(regressionDurability) === 'REGRESSION', 'Regression durability');

  // 4. Return analysis
  assert(evaluateReturnAnalysis({ attempts: 10, cumulativeImprovement: 5, incrementalImprovement: 0.8, costPerImprovement: 1, riskPerImprovement: 0.1, failedAttempts: 1, rollbackFrequency: 0.05, telemetryFresh: true }) === 'HIGH_RETURN', 'High return');
  assert(evaluateReturnAnalysis({ attempts: 20, cumulativeImprovement: 10, incrementalImprovement: 0.1, costPerImprovement: 5, riskPerImprovement: 0.5, failedAttempts: 8, rollbackFrequency: 0.3, telemetryFresh: true }) === 'DIMINISHING_RETURN', 'Diminishing return');
  assert(evaluateReturnAnalysis({ attempts: 20, cumulativeImprovement: -1, incrementalImprovement: -0.5, costPerImprovement: 5, riskPerImprovement: 0.8, failedAttempts: 15, rollbackFrequency: 0.6, telemetryFresh: true }) === 'NEGATIVE_RETURN', 'Negative return');
  assert(evaluateReturnAnalysis({ attempts: 30, cumulativeImprovement: 20, incrementalImprovement: 0, costPerImprovement: 0.1, riskPerImprovement: 0.01, failedAttempts: 0, rollbackFrequency: 0, telemetryFresh: true }) === 'OPTIMIZATION_SATURATION', 'Optimization saturation');

  // 5. Fatigue
  assert(evaluateOptimizationFatigue({ changeFrequency: 1, repeatedRollouts: 0, repeatedRollbacks: 0, unstableMetrics: false, oscillatingPolicies: false, insufficientObservationWindows: false, overlappingExperiments: 0, resourceConsumption: 0.1, telemetryFresh: true }) === 'HEALTHY', 'Fatigue healthy');
  assert(evaluateOptimizationFatigue({ changeFrequency: 10, repeatedRollouts: 3, repeatedRollbacks: 1, unstableMetrics: true, oscillatingPolicies: false, insufficientObservationWindows: false, overlappingExperiments: 0, resourceConsumption: 0.3, telemetryFresh: true }) === 'WATCH', 'Fatigue watch');
  assert(evaluateOptimizationFatigue({ changeFrequency: 25, repeatedRollouts: 8, repeatedRollbacks: 5, unstableMetrics: true, oscillatingPolicies: true, insufficientObservationWindows: true, overlappingExperiments: 3, resourceConsumption: 0.7, telemetryFresh: true }) === 'THRASHING', 'Fatigue thrashing');
  assert(evaluateOptimizationFatigue({ changeFrequency: 5, repeatedRollouts: 2, repeatedRollbacks: 1, unstableMetrics: false, oscillatingPolicies: false, insufficientObservationWindows: false, overlappingExperiments: 10, resourceConsumption: 0.95, telemetryFresh: true }) === 'FROZEN', 'Fatigue frozen');

  // 6. Interaction (positive delta = improvement)
  assert(classifyStrategyInteraction({ strategyA: 'A', strategyB: 'B', combinedDelta: { performance: 0.2, latency: 0.1 }, observedAAlone: { performance: 0.05 }, observedBAlone: { performance: 0.05 }, temporalOrdering: true, controlledEvidence: true, confidence: 'HIGH', telemetryFresh: true }) === 'SYNERGISTIC', 'Synergistic interaction');
  assert(classifyStrategyInteraction({ strategyA: 'A', strategyB: 'B', combinedDelta: { performance: -0.1 }, observedAAlone: { performance: 0.05 }, observedBAlone: { performance: 0.05 }, temporalOrdering: true, controlledEvidence: true, confidence: 'HIGH', telemetryFresh: true }) === 'ANTAGONISTIC', 'Antagonistic interaction');
  assert(classifyStrategyInteraction({ strategyA: 'A', strategyB: 'B', combinedDelta: { performance: 0.1 }, observedAAlone: { performance: 0.05 }, observedBAlone: { performance: 0.05 }, temporalOrdering: true, controlledEvidence: true, confidence: 'HIGH', telemetryFresh: true }) === 'NEUTRAL', 'Neutral interaction');
  assert(classifyStrategyInteraction({ strategyA: 'A', strategyB: 'B', combinedDelta: { performance: 0.1 }, observedAAlone: { performance: 0.05 }, observedBAlone: { performance: 0.05 }, temporalOrdering: false, controlledEvidence: true, confidence: 'HIGH', telemetryFresh: true }) === 'UNCONFIRMED', 'Unconfirmed interaction');

  // 7. Historical memory
  const histMemory: HistoricalEvidence[] = [
    { tenantId: 'tenantA', objective: 'COST', scope: 'fleet', environment: 'production', policyVersion: 'v1', successCount: 5, failureCount: 1, regressionCount: 0, similarExperiments: ['exp1'], knownInteractions: [], durabilityEvidence: ['durable1'], riskHistory: ['low'], confidence: 'HIGH' },
    { tenantId: 'tenantA', objective: 'COST', scope: 'fleet', environment: 'production', policyVersion: 'v2', successCount: 1, failureCount: 2, regressionCount: 1, similarExperiments: ['exp2'], knownInteractions: [], durabilityEvidence: ['regression1'], riskHistory: ['high'], confidence: 'LOW' },
  ];
  const hist = retrieveHistoricalEvidence({ tenantId: 'tenantA', objective: 'COST', scope: 'fleet', environment: 'production', policyVersion: 'v1' }, histMemory);
  assert(hist !== null && hist.successCount > 0, 'Historical success retrieved');
  assert(hist!.confidence === 'MEDIUM', 'Historical confidence computed');

  // 8. Failure memory
  const failure = createFailureMemoryRecord({ tenantId: 'tenantA', strategy: 'reduce-idle', failureReason: 'latency spike', failureScope: 'fleet', failureEvidence: ['ev1'], failureConfidence: 'HIGH', revalidationAllowed: false });
  assert(shouldBlockRepeatedFailure(failure, 'production', 'v1', 'normal') === true, 'Repeated failure blocked');

  // 9. Long-horizon decision
  assert(makeLongHorizonDecision({ shortTermImpact: 0.1, mediumTermImpact: 0.1, longTermImpact: 0.1, durability: 'DURABLE_IMPROVEMENT', confidence: 'HIGH', risk: 'LOW', resourceCost: 1, rollbackCost: 0.5, governanceAllowed: true, safetyAllowed: true, resourceBudgetExceeded: false, staleTelemetry: false }) === 'PROMOTE', 'Long-horizon promote');
  assert(makeLongHorizonDecision({ shortTermImpact: 0.1, mediumTermImpact: -0.1, longTermImpact: -0.2, durability: 'REGRESSION', confidence: 'HIGH', risk: 'LOW', resourceCost: 1, rollbackCost: 0.5, governanceAllowed: true, safetyAllowed: true, resourceBudgetExceeded: false, staleTelemetry: false }) === 'ROLLBACK', 'Long-horizon rollback');
  assert(makeLongHorizonDecision({ shortTermImpact: 0.1, mediumTermImpact: 0.05, longTermImpact: 0.02, durability: 'PROVISIONAL_IMPROVEMENT', confidence: 'LOW', risk: 'MEDIUM', resourceCost: 1, rollbackCost: 0.5, governanceAllowed: true, safetyAllowed: true, resourceBudgetExceeded: false, staleTelemetry: false }) === 'HOLD', 'Long-horizon hold due to low confidence');

  // 10. Recommendation
  const recommendation = createOptimizationRecommendation({
    tenantId: 'tenantA', affectedObjective: 'COST', expectedBenefit: 0.2, expectedRisk: 'LOW',
    confidence: 'HIGH', historicalEvidence: ['ev1'], freshness: 'FRESH', governingPolicy: 'gov1',
    decisionLineage: ['d1'], fatigueState: 'HEALTHY', returnClassification: 'HIGH_RETURN', durability: 'DURABLE_IMPROVEMENT'
  }, 'corr1');
  assert(recommendation.recommendationType === 'PROMOTE', 'Recommendation promote');
  assert(recommendation.idempotencyKey === 'tenantA:corr1', 'Recommendation idempotency');

  // 11. Orchestrator smoke test
  const orchestratorResult = orchestrateLongHorizonOptimization({
    tenantId: 'tenantA', correlationId: 'corr1',
    temporalObservations: temporalObservations,
    durabilityInput: durableInput,
    returnInput: { attempts: 10, cumulativeImprovement: 5, incrementalImprovement: 0.8, costPerImprovement: 1, riskPerImprovement: 0.1, failedAttempts: 1, rollbackFrequency: 0.05, telemetryFresh: true },
    fatigueInput: { changeFrequency: 1, repeatedRollouts: 0, repeatedRollbacks: 0, unstableMetrics: false, oscillatingPolicies: false, insufficientObservationWindows: false, overlappingExperiments: 0, resourceConsumption: 0.1, telemetryFresh: true },
    interactionInput: { strategyA: 'A', strategyB: 'B', combinedDelta: { performance: 0.2 }, observedAAlone: { performance: 0.05 }, observedBAlone: { performance: 0.05 }, temporalOrdering: true, controlledEvidence: true, confidence: 'HIGH', telemetryFresh: true },
    historicalMemory: histMemory,
    failureMemory: [],
    decisionInput: { shortTermImpact: 0.1, mediumTermImpact: 0.1, longTermImpact: 0.1, durability: 'DURABLE_IMPROVEMENT', confidence: 'HIGH', risk: 'LOW', resourceCost: 1, rollbackCost: 0.5, governanceAllowed: true, safetyAllowed: true, resourceBudgetExceeded: false, staleTelemetry: false },
    recommendationInput: {
      affectedObjective: 'COST', expectedBenefit: 0.2, expectedRisk: 'LOW', confidence: 'HIGH',
      historicalEvidence: ['ev1'], freshness: 'FRESH', governingPolicy: 'gov1', decisionLineage: ['d1'],
      fatigueState: 'HEALTHY', returnClassification: 'HIGH_RETURN', durability: 'DURABLE_IMPROVEMENT'
    },
    resourceBudgetExceeded: false,
    staleTelemetry: false,
  });
  assert(orchestratorResult.decision === 'PROMOTE', 'Orchestrator promotes');
  assert(orchestratorResult.recommendation.recommendationType === 'PROMOTE', 'Orchestrator recommendation promote');
  assert(orchestratorResult.auditEvents.length >= 4, 'Orchestrator audit events');

  // 12. Secret redaction
  const redacted = redactSecrets({ password: 'secret123', nested: { token: 'abc', arr: [{ apiKey: 'key123' }] } });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redacted');
  assert(!JSON.stringify(redacted).includes('abc'), 'Token redacted');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redacted nested');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) {
    console.log('PHASE 17 PASS 32: FAIL');
    process.exit(1);
  } else {
    console.log('PHASE 17 PASS 32: PASS');
  }
}

main();
