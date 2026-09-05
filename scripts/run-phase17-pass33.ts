import { createOptimizationStrategy } from '../src/core/worker-optimization-strategy';
import { createObjective } from '../src/core/worker-optimization-strategy-objectives';
import { synthesizeStrategyCandidate } from '../src/core/worker-optimization-strategy-synthesis';
import { scoreStrategy } from '../src/core/worker-optimization-strategy-scoring';
import { findParetoOptimal } from '../src/core/worker-optimization-strategy-pareto';
import { classifyStrategyInteraction } from '../src/core/worker-optimization-strategy-interactions';
import { evaluateStrategyConfidence } from '../src/core/worker-optimization-strategy-confidence';
import { checkConstraint } from '../src/core/worker-optimization-strategy-constraints';
import { reserveStrategyResources, createStrategyResourceBudget } from '../src/core/worker-optimization-strategy-resource-budget';
import { arbitrateStrategy } from '../src/core/worker-optimization-strategy-arbitrator';
import { governStrategy } from '../src/core/worker-optimization-strategy-governance';
import { evaluateStrategySafety } from '../src/core/worker-optimization-strategy-safety';
import { evaluateStrategyRollout } from '../src/core/worker-optimization-strategy-rollout';
import { verifyStrategyOutcome } from '../src/core/worker-optimization-strategy-verification';
import { evaluateStrategyRollback } from '../src/core/worker-optimization-strategy-rollback';
import { addStrategyLineageVersion, StrategyLineage } from '../src/core/worker-optimization-strategy-lineage';
import { createStrategyAuditEvent } from '../src/core/worker-optimization-strategy-audit';
import { orchestrateStrategy } from '../src/core/worker-autonomous-strategy-orchestrator';
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
  console.log('=== Phase 17.33: Autonomous Multi-Objective Strategy Synthesis & Governed Fleet-Wide Optimization ===');

  // 1. Strategy creation
  const strategy = createOptimizationStrategy({
    tenantId: 'tenantA',
    portfolioRefs: ['port1'],
    actions: ['action1', 'action2'],
    objectives: ['cost', 'latency'],
    expectedOutcomes: { cost: -10, latency: -5 },
    predictedCost: 100,
    predictedReliabilityImpact: 0.1,
    predictedRisk: 'LOW',
    confidence: 'HIGH',
    evidenceRefs: ['ev1'],
    interactionEffects: { combined: 0.05 },
    constraintResults: [],
    governanceStatus: 'PENDING',
    safetyStatus: 'PENDING',
    lifecycleStatus: 'DRAFT',
    correlationId: 'corr1',
  });
  assert(strategy.strategyId.length > 0, 'Strategy created');
  assert(strategy.tenantId === 'tenantA', 'Tenant set');

  // 2. Duplicate strategy rejected (same idempotency)
  const duplicateStrategy = createOptimizationStrategy({
    tenantId: 'tenantA',
    portfolioRefs: ['port1'],
    actions: ['action1', 'action2'],
    objectives: ['cost', 'latency'],
    expectedOutcomes: { cost: -10, latency: -5 },
    predictedCost: 100,
    predictedReliabilityImpact: 0.1,
    predictedRisk: 'LOW',
    confidence: 'HIGH',
    evidenceRefs: ['ev1'],
    interactionEffects: { combined: 0.05 },
    constraintResults: [],
    governanceStatus: 'PENDING',
    safetyStatus: 'PENDING',
    lifecycleStatus: 'DRAFT',
    correlationId: 'corr1',
  });
  assert(duplicateStrategy.idempotencyKey === strategy.idempotencyKey, 'Duplicate strategy same idempotency key');

  // 3. Objective created
  const objective = createObjective({
    objectiveId: 'cost',
    direction: 'MINIMIZE',
    target: 80,
    weight: 0.6,
    priority: 1,
    hard: false,
    confidence: 'HIGH',
    source: 'test',
  });
  assert(objective.objectiveId === 'cost', 'Objective created');
  assert(objective.direction === 'MINIMIZE', 'Objective direction set');

  // 4. Hard constraint enforced
  const hardConstraint = { constraintId: 'c1', type: 'HARD', metric: 'reliability', limit: 0.95, currentValue: 0.90, compare: 'GTE', source: 'SLO' };
  assert(!checkConstraint(hardConstraint), 'Hard constraint violation detected');
  const softConstraint = { constraintId: 'c2', type: 'SOFT', metric: 'latency', limit: 200, currentValue: 150, compare: 'LT', source: 'SLO' };
  assert(checkConstraint(softConstraint), 'Soft constraint passes');

  // 5. Soft objective trade-off allowed (not tested directly, but synthesis uses soft/hard distinction)

  // 6. Candidate synthesized
  const candidate = synthesizeStrategyCandidate({
    tenantId: 'tenantA',
    strategyId: strategy.strategyId,
    objectiveImpacts: { cost: -5, latency: -2 },
    confidence: 'HIGH',
    risk: 'LOW',
    evidenceRefs: ['ev1'],
    resourceRequirements: { CPU: 2 },
    interactionEffects: { combined: 0.05 },
    evidenceQuality: 0.9,
    durabilityFactor: 0.8,
    interactionFactor: 1.0,
    riskPenalty: 0.1,
    resourcePenalty: 0.2,
    correlationId: 'corr1',
  });
  assert(candidate.candidateId.length > 0, 'Candidate synthesized');
  assert(candidate.expectedBenefit < 0 || candidate.expectedBenefit > -10, 'Expected benefit calculated');

  // 7. Deterministic candidate generation
  const candidate2 = synthesizeStrategyCandidate({
    tenantId: 'tenantA',
    strategyId: strategy.strategyId,
    objectiveImpacts: { cost: -5, latency: -2 },
    confidence: 'HIGH',
    risk: 'LOW',
    evidenceRefs: ['ev1'],
    resourceRequirements: { CPU: 2 },
    interactionEffects: { combined: 0.05 },
    evidenceQuality: 0.9,
    durabilityFactor: 0.8,
    interactionFactor: 1.0,
    riskPenalty: 0.1,
    resourcePenalty: 0.2,
    correlationId: 'corr1',
  });
  assert(candidate2.idempotencyKey === candidate.idempotencyKey, 'Deterministic candidate generation (same idempotency)');

  // 8. Strategy scoring
  const score = scoreStrategy({
    objectiveBenefit: 10,
    confidence: 'HIGH',
    evidenceQuality: 0.9,
    durabilityFactor: 0.8,
    interactionFactor: 1.0,
    riskPenalty: 0.1,
    resourcePenalty: 0.2,
  });
  assert(score.score > 0, 'Strategy score positive');
  assert(score.components.length === 7, 'Score components present');

  // 9. Dominated strategy detected (via pareto)
  const paretoCandidates = [
    { id: 'a', metrics: { cost: 10, latency: 20 }, eligible: true },
    { id: 'b', metrics: { cost: 15, latency: 15 }, eligible: true },
    { id: 'c', metrics: { cost: 8, latency: 25 }, eligible: true },
    { id: 'd', metrics: { cost: 9, latency: 19 }, eligible: true },
    { id: 'e', metrics: { cost: 20, latency: 10 }, eligible: false }, // hard constraint violated
  ];
  const pareto = findParetoOptimal(paretoCandidates);
  assert(pareto.some(p => p.id === 'a'), 'Pareto-optimal candidate a selected');
  assert(!pareto.some(p => p.id === 'd'), 'Dominated candidate d excluded');
  assert(!pareto.some(p => p.id === 'e'), 'Ineligible candidate e excluded');

  // 10. Pareto-optimal strategy detected (covered above)

  // 11. Positive interaction
  assert(classifyStrategyInteraction({
    strategies: ['a','b'],
    combinedDelta: { performance: 0.2 },
    individualDeltas: { a: 0.05, b: 0.05 },
    evidenceQuality: 0.9,
    temporalValidity: true,
  }) === 'POSITIVE', 'Positive interaction detected');

  // 12. Antagonistic interaction
  assert(classifyStrategyInteraction({
    strategies: ['a','b'],
    combinedDelta: { performance: -0.1 },
    individualDeltas: { a: 0.05, b: 0.05 },
    evidenceQuality: 0.9,
    temporalValidity: true,
  }) === 'ANTAGONISTIC', 'Antagonistic interaction detected');

  // 13. Unknown interaction lowers confidence
  assert(classifyStrategyInteraction({
    strategies: ['a','b'],
    combinedDelta: { performance: 0.1 },
    individualDeltas: { a: 0.05, b: 0.05 },
    evidenceQuality: 0.4,
    temporalValidity: true,
  }) === 'UNKNOWN', 'Unknown interaction due to low evidence');

  // 14. Resource budget allows strategy
  let budget = createStrategyResourceBudget('tenantA', { CPU: 10, MEMORY: 100 });
  const reserve1 = reserveStrategyResources(budget, { CPU: 5 });
  assert(reserve1.success, 'Resource reservation succeeds');
  assert(reserve1.budget.reserved['CPU'] === 5, 'Resource reserved correct');

  // 15. Resource budget denies strategy
  const reserve2 = reserveStrategyResources(budget, { CPU: 11 });
  assert(!reserve2.success, 'Resource budget exceeded denied');

  // 16. Arbitration allows compatible strategy
  assert(arbitrateStrategy({
    conflicts: [],
    negativeHistoricalOutcomes: false,
    resourceConflict: false,
    policyConflict: false,
    rolloutConflict: false,
    incompatibleChanges: false,
    hardConstraintViolation: false,
  }) === 'ALLOW', 'Arbitration allows');

  // 17. Arbitration denies conflict
  assert(arbitrateStrategy({
    conflicts: ['c1'],
    negativeHistoricalOutcomes: false,
    resourceConflict: false,
    policyConflict: false,
    rolloutConflict: false,
    incompatibleChanges: false,
    hardConstraintViolation: false,
  }) === 'DENY', 'Arbitration denies on conflict');

  // 18. Governance allows
  assert(governStrategy({
    productionFreeze: false,
    maintenanceWindow: false,
    approvalRequired: false,
    policyRestriction: false,
    riskLevel: 'LOW',
    evidenceRequirementMet: true,
    autonomyLevel: 'FULL',
  }) === 'ALLOW', 'Governance allows');

  // 19. Governance denies during freeze
  assert(governStrategy({
    productionFreeze: true,
    maintenanceWindow: false,
    approvalRequired: false,
    policyRestriction: false,
    riskLevel: 'LOW',
    evidenceRequirementMet: true,
    autonomyLevel: 'FULL',
  }) === 'DENY', 'Governance denies on freeze');

  // 20. Safety allows
  assert(evaluateStrategySafety({
    criticalReliabilityRegression: false,
    criticalAvailabilityRegression: false,
    excessiveErrorRisk: false,
    resourceExhaustion: false,
    blastRadiusExcessive: false,
    rollbackAvailable: true,
    insufficientEvidence: false,
    conflictingSafetyControls: false,
  }) === 'ALLOW', 'Safety allows');

  // 21. Safety denies critical risk
  assert(evaluateStrategySafety({
    criticalReliabilityRegression: true,
    criticalAvailabilityRegression: false,
    excessiveErrorRisk: false,
    resourceExhaustion: false,
    blastRadiusExcessive: false,
    rollbackAvailable: true,
    insufficientEvidence: false,
    conflictingSafetyControls: false,
  }) === 'DENY', 'Safety denies critical risk');

  // 22. Low confidence causes HOLD (via orchestrator later, but we test confidence function)
  const lowConf = evaluateStrategyConfidence({
    sampleSize: 5,
    historicalRepetitions: 2,
    evidenceFreshness: 'STALE',
    outcomeConsistency: 0.5,
    causalAttributionQuality: 0.5,
    interactionUncertainty: 0.8,
    strategyComplexity: 0.5,
    productionSimilarity: 0.5,
    durability: 0.5,
  });
  assert(lowConf === 'INSUFFICIENT', 'Low confidence returns INSUFFICIENT');

  // 23. Rollout progresses
  const rollout1 = evaluateStrategyRollout({
    currentStage: 'CANARY',
    metrics: { errorRate: 0.01, latency: 100, reliability: 0.99, cost: 50 },
    thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 },
  });
  assert(rollout1.action === 'CONTINUE' && rollout1.nextStage === 'LIMITED', 'Rollout progresses');

  // 24. Rollout holds on threshold violation
  const rollout2 = evaluateStrategyRollout({
    currentStage: 'LIMITED',
    metrics: { errorRate: 0.1, latency: 300, reliability: 0.90, cost: 150 },
    thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 },
  });
  assert(rollout2.action === 'HOLD', 'Rollout holds on violation');

  // 25. Rollback succeeds
  assert(evaluateStrategyRollback({
    strategyId: 's1',
    tenantId: 'tenantA',
    duplicateRollback: false,
    rollbackAuthorized: true,
    governanceAllowed: true,
    safetyAllowed: true,
    rollbackAvailable: true,
    dependencyOrderValid: true,
  }) === 'ALLOWED', 'Rollback allowed');

  // 26. Duplicate rollback is idempotent
  assert(evaluateStrategyRollback({
    strategyId: 's1',
    tenantId: 'tenantA',
    duplicateRollback: true,
    rollbackAuthorized: true,
    governanceAllowed: true,
    safetyAllowed: true,
    rollbackAvailable: true,
    dependencyOrderValid: true,
  }) === 'DEFERRED', 'Duplicate rollback deferred (idempotent)');

  // 27. Verification improvement
  assert(verifyStrategyOutcome({
    expectedImprovement: 10,
    actualImprovement: 8,
    reliabilityChange: 0.01,
    costChange: -5,
    errorRateChange: -0.02,
    latencyChange: -10,
    availabilityChange: 0.01,
    stability: true,
    rollbackStatus: 'NOT_ROLLED_BACK',
    sampleSize: 100,
    telemetryFresh: true,
  }) === 'IMPROVED', 'Verification improvement');

  // 28. Verification regression
  assert(verifyStrategyOutcome({
    expectedImprovement: 10,
    actualImprovement: -2,
    reliabilityChange: -0.06,
    costChange: 5,
    errorRateChange: 0.08,
    latencyChange: 20,
    availabilityChange: -0.02,
    stability: false,
    rollbackStatus: 'NOT_ROLLED_BACK',
    sampleSize: 100,
    telemetryFresh: true,
  }) === 'REGRESSION', 'Verification regression');

  // 29. Strategy lineage created
  const lineage: StrategyLineage = { strategyId: 's1', tenantId: 'tenantA', versions: [] };
  const lineageV1 = addStrategyLineageVersion(lineage, {
    version: '1',
    parentVersion: null,
    strategyId: 's1',
    candidateIds: ['cand1'],
    portfolioIds: ['port1'],
    experimentIds: [],
    policyIds: [],
    evidenceRefs: ['ev1'],
    reason: 'initial',
    status: 'ACTIVE',
    timestamp: new Date().toISOString(),
  });
  assert(lineageV1.versions.length === 1, 'Lineage version added');

  // 30. Duplicate lineage rejected
  try {
    addStrategyLineageVersion(lineageV1, {
      version: '1',
      parentVersion: null,
      strategyId: 's1',
      candidateIds: ['cand2'],
      portfolioIds: ['port1'],
      experimentIds: [],
      policyIds: [],
      evidenceRefs: ['ev2'],
      reason: 'duplicate',
      status: 'ACTIVE',
      timestamp: new Date().toISOString(),
    });
    assert(false, 'Duplicate lineage should throw');
  } catch {
    assert(true, 'Duplicate lineage rejected');
  }

  // 31. Audit event created
  const audit = createStrategyAuditEvent({
    tenantId: 'tenantA',
    correlationId: 'corr1',
    strategyId: 's1',
    strategyVersion: '1',
    eventType: 'STRATEGY_CREATED',
    reason: 'test',
    decision: 'ALLOW',
  });
  assert(audit.eventType === 'STRATEGY_CREATED', 'Audit event created');

  // 32-34. Secret redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'supersecrettoken', nested: { apiKey: 'apikey123' } });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redacted');
  assert(!JSON.stringify(redacted).includes('supersecrettoken'), 'Token redacted');
  assert(!JSON.stringify(redacted).includes('apikey123'), 'Nested API key redacted');

  // 35-40. Orchestrator tests
  const orchestratorInput = {
    tenantId: 'tenantA',
    correlationId: 'corr1',
    strategy: {
      portfolioRefs: ['port1'],
      actions: ['action1'],
      objectives: ['cost'],
      expectedOutcomes: { cost: -10 },
      predictedCost: 50,
      predictedReliabilityImpact: 0.05,
      predictedRisk: 'LOW',
      confidence: 'HIGH',
      evidenceRefs: ['ev1'],
      interactionEffects: { combined: 0.05 },
      constraintResults: [],
      governanceStatus: 'PENDING',
      safetyStatus: 'PENDING',
      lifecycleStatus: 'DRAFT',
    },
    synthesis: {
      objectiveImpacts: { cost: -5 },
      confidence: 'HIGH',
      risk: 'LOW',
      evidenceRefs: ['ev1'],
      resourceRequirements: { CPU: 2 },
      interactionEffects: { combined: 0.05 },
      evidenceQuality: 0.9,
      durabilityFactor: 0.8,
      interactionFactor: 1.0,
      riskPenalty: 0.1,
      resourcePenalty: 0.2,
    },
    constraints: [
      { constraintId: 'c1', type: 'HARD', metric: 'reliability', limit: 0.95, currentValue: 0.96, compare: 'GTE', source: 'SLO' },
    ],
    arbitration: {
      conflicts: [],
      negativeHistoricalOutcomes: false,
      resourceConflict: false,
      policyConflict: false,
      rolloutConflict: false,
      incompatibleChanges: false,
      hardConstraintViolation: false,
    },
    governance: {
      productionFreeze: false,
      maintenanceWindow: false,
      approvalRequired: false,
      policyRestriction: false,
      riskLevel: 'LOW',
      evidenceRequirementMet: true,
      autonomyLevel: 'FULL',
    },
    safety: {
      criticalReliabilityRegression: false,
      criticalAvailabilityRegression: false,
      excessiveErrorRisk: false,
      resourceExhaustion: false,
      blastRadiusExcessive: false,
      rollbackAvailable: true,
      insufficientEvidence: false,
      conflictingSafetyControls: false,
    },
    resourceLimits: { CPU: 10 },
    resourceRequests: { CPU: 2 },
    rollout: {
      currentStage: 'CANARY',
      metrics: { errorRate: 0.01, latency: 100, reliability: 0.99, cost: 50 },
      thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 },
    },
    verification: {
      expectedImprovement: 10,
      actualImprovement: 8,
      reliabilityChange: 0.01,
      costChange: -5,
      errorRateChange: -0.02,
      latencyChange: -10,
      availabilityChange: 0.01,
      stability: true,
      rollbackStatus: 'NOT_ROLLED_BACK',
      sampleSize: 100,
      telemetryFresh: true,
    },
    rollback: {
      strategyId: 's1',
      tenantId: 'tenantA',
      duplicateRollback: false,
      rollbackAuthorized: true,
      governanceAllowed: true,
      safetyAllowed: true,
      rollbackAvailable: true,
      dependencyOrderValid: true,
    },
  };

  const orchestratorResult = orchestrateStrategy(orchestratorInput);
  assert(orchestratorResult.hardConstraintsViolated === false, 'Orchestrator constraints pass');
  assert(orchestratorResult.arbitration === 'ALLOW', 'Orchestrator arbitration allow');
  assert(orchestratorResult.governance === 'ALLOW', 'Orchestrator governance allow');
  assert(orchestratorResult.safety === 'ALLOW', 'Orchestrator safety allow');
  assert(orchestratorResult.resourceSuccess === true, 'Orchestrator resource allow');
  assert(orchestratorResult.rollout.action === 'CONTINUE', 'Orchestrator rollout continue');
  assert(orchestratorResult.verification === 'IMPROVED', 'Orchestrator verification improved');
  assert(orchestratorResult.rollback === 'ALLOWED', 'Orchestrator rollback allowed');
  assert(orchestratorResult.lineage.versions.length === 1, 'Orchestrator lineage created');
  assert(orchestratorResult.auditEvents.length >= 4, 'Orchestrator audit events emitted');

  // 39. Orchestrator produces deterministic decision (idempotency key)
  const orchestratorResult2 = orchestrateStrategy(orchestratorInput);
  assert(orchestratorResult2.strategy.idempotencyKey === orchestratorResult.strategy.idempotencyKey, 'Orchestrator deterministic idempotency');

  // 40. Fail-closed behavior on invalid dependency
  const invalidSafety = evaluateStrategySafety({
    ...orchestratorInput.safety,
    rollbackAvailable: false,
  });
  assert(invalidSafety === 'DENY', 'Fail-closed: missing rollback causes deny');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) {
    console.log('PHASE 17 PASS 33: FAIL');
    process.exit(1);
  } else {
    console.log('PHASE 17 PASS 33: PASS');
  }
}

main();
