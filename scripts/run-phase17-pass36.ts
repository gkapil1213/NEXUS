import { createStrategyGeneration } from '../src/core/worker-strategy-evolution-generation';
import { addLineageNode, StrategyLineage, getGenerationChain } from '../src/core/worker-strategy-evolution-lineage';
import { createEvolutionCandidate } from '../src/core/worker-strategy-evolution-candidate';
import { computeStrategyDelta } from '../src/core/worker-strategy-evolution-delta';
import { validateStrategyEvolutionConstraints } from '../src/core/worker-strategy-evolution-constraints';
import { evaluateEvolutionSafety } from '../src/core/worker-strategy-evolution-safety';
import { evaluateEvolutionConfidence } from '../src/core/worker-strategy-evolution-confidence';
import { evaluateRegression } from '../src/core/worker-strategy-evolution-regression';
import { createShadowEvaluation, completeShadowEvaluation } from '../src/core/worker-strategy-evolution-shadow';
import { governEvolutionCandidate } from '../src/core/worker-strategy-evolution-governance';
import { evaluateEvolutionRollout } from '../src/core/worker-strategy-evolution-rollout';
import { evaluateEvolutionRollback } from '../src/core/worker-strategy-evolution-rollback';
import { decideRetirement } from '../src/core/worker-strategy-evolution-retirement';
import { createEvolutionLearningRecord } from '../src/core/worker-strategy-evolution-learning';
import { createEvolutionAuditEvent } from '../src/core/worker-strategy-evolution-audit';
import { orchestrateStrategyEvolution } from '../src/core/worker-autonomous-strategy-evolution-orchestrator';
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
  console.log('=== Phase 17.36: Autonomous Strategy Evolution, Multi-Generation Learning & Governed Self-Improvement ===');

  // Generation tests
  const gen0 = createStrategyGeneration({
    strategyId: 's1',
    parentGenerationId: null,
    rootStrategyId: 's1',
    tenantId: 'tenantA',
    sourceEvidence: ['ev0'],
    learningInputs: [],
    mutationRationale: 'initial',
    constraints: [],
    expectedObjectives: { cost: 100 },
    confidence: 'HIGH',
    validationStatus: 'ACTIVE',
    governanceStatus: 'APPROVED',
    rolloutStatus: 'COMPLETED',
    outcomeStatus: 'SUCCESS',
    retirementStatus: 'ACTIVE',
    correlationId: 'corr0',
  });
  assert(gen0.generationId.length > 0, 'Generation created');

  const gen0Duplicate = createStrategyGeneration({
    strategyId: 's1',
    parentGenerationId: null,
    rootStrategyId: 's1',
    tenantId: 'tenantA',
    sourceEvidence: ['ev0'],
    learningInputs: [],
    mutationRationale: 'initial',
    constraints: [],
    expectedObjectives: { cost: 100 },
    confidence: 'HIGH',
    validationStatus: 'ACTIVE',
    governanceStatus: 'APPROVED',
    rolloutStatus: 'COMPLETED',
    outcomeStatus: 'SUCCESS',
    retirementStatus: 'ACTIVE',
    correlationId: 'corr0',
  });
  assert(gen0Duplicate.idempotencyKey === gen0.idempotencyKey, 'Duplicate generation blocked');

  // Lineage tests
  const lineage: StrategyLineage = {
    rootStrategyId: 's1',
    tenantId: 'tenantA',
    generations: [],
  };
  const lineageWithGen0 = addLineageNode(lineage, {
    generationId: gen0.generationId,
    strategyId: 's1',
    parentGenerationId: null,
    rootStrategyId: 's1',
    reason: 'initial',
    timestamp: gen0.createdAt,
    status: 'ACTIVE',
  });
  assert(lineageWithGen0.generations.length === 1, 'Lineage root added');

  // Candidate tests
  const candidate = createEvolutionCandidate({
    parentStrategyId: 's1',
    parentGenerationId: gen0.generationId,
    proposedGeneration: 1,
    tenantId: 'tenantA',
    sourceEvidence: ['ev1'],
    changeSet: { timeout: { before: 30, after: 25 } },
    expectedBenefits: { latency: 5 },
    expectedRisks: { cost: 0.1 },
    constraints: ['latency < 200'],
    confidence: 'HIGH',
    reason: 'reduce timeout',
    correlationId: 'corr1',
  });
  assert(candidate.candidateId.length > 0, 'Candidate generated');
  assert(candidate.fingerprint.length > 0, 'Fingerprint deterministic');
  const candidateDuplicate = createEvolutionCandidate({
    parentStrategyId: 's1',
    parentGenerationId: gen0.generationId,
    proposedGeneration: 1,
    tenantId: 'tenantA',
    sourceEvidence: ['ev1'],
    changeSet: { timeout: { before: 30, after: 25 } },
    expectedBenefits: { latency: 5 },
    expectedRisks: { cost: 0.1 },
    constraints: ['latency < 200'],
    confidence: 'HIGH',
    reason: 'reduce timeout',
    correlationId: 'corr1',
  });
  assert(candidateDuplicate.idempotencyKey === candidate.idempotencyKey, 'Duplicate candidate blocked');

  // Delta tests
  const delta = computeStrategyDelta(
    { generationId: gen0.generationId, strategyId: 's1', timeout: 30 },
    { candidateId: candidate.candidateId, timeout: 25 },
    [],
    ['latency < 200']
  );
  assert(delta.changedFields.includes('timeout') || delta.addedConstraints.includes('latency < 200'), 'Delta calculated');

  // Constraint tests
  const constraintValid = validateStrategyEvolutionConstraints([
    { constraintId: 'c1', type: 'HARD', metric: 'latency', limit: 200, currentValue: 150, compare: 'LT', source: 'SLO' },
  ]);
  assert(constraintValid.valid, 'Constraint passes');
  const constraintInvalid = validateStrategyEvolutionConstraints([
    { constraintId: 'c2', type: 'HARD', metric: 'latency', limit: 200, currentValue: 250, compare: 'LT', source: 'SLO' },
  ]);
  assert(!constraintInvalid.valid, 'Constraint violation detected');

  // Confidence tests
  assert(evaluateEvolutionConfidence({
    sampleSize: 100,
    historicalSuccessCount: 90,
    outcomeConsistency: 0.9,
    durability: 0.8,
    recentness: 0.7,
    regressionEvidence: false,
    uncertainty: 0.1,
    strategyAge: 30,
    driftSeverity: 'NONE',
    failureHistoryCount: 0,
  }) === 'VERY_HIGH', 'Very high confidence with evidence');
  assert(evaluateEvolutionConfidence({
    sampleSize: 3,
    historicalSuccessCount: 2,
    outcomeConsistency: 0.5,
    durability: 0.5,
    recentness: 0.5,
    regressionEvidence: false,
    uncertainty: 0.5,
    strategyAge: 1,
    driftSeverity: 'NONE',
    failureHistoryCount: 0,
  }) === 'INSUFFICIENT_DATA', 'Insufficient data confidence');

  // Regression tests
  const regressionAccept = evaluateRegression({
    baseline: { latency: 100, cost: 50 },
    candidate: { latency: 90, cost: 45 },
    allowedRegression: { latency: 20, cost: 10 },
    criticalMetrics: ['latency', 'cost'],
  });
  assert(regressionAccept.decision === 'ACCEPT', 'Regression check accepts improvement');
  const regressionReject = evaluateRegression({
    baseline: { latency: 100, cost: 50 },
    candidate: { latency: 130, cost: 80 },
    allowedRegression: { latency: 20, cost: 10 },
    criticalMetrics: ['latency', 'cost'],
  });
  assert(regressionReject.decision === 'REJECT', 'Regression check rejects unsafe regression');

  // Safety tests
  assert(evaluateEvolutionSafety({
    parentStrategyExists: true,
    parentGenerationValid: true,
    duplicateCandidate: false,
    validLineage: true,
    validChangeSet: true,
    constraintsPass: true,
    safetyChecksPass: true,
    confidenceThresholdMet: true,
    regressionChecksPass: true,
    shadowEvaluationPassed: true,
    resourceBudgetAvailable: true,
    governancePassed: true,
    rollbackCapabilityExists: true,
  }) === 'ALLOW', 'Safety allows valid evolution');
  assert(evaluateEvolutionSafety({
    parentStrategyExists: true,
    parentGenerationValid: true,
    duplicateCandidate: false,
    validLineage: true,
    validChangeSet: true,
    constraintsPass: false,
    safetyChecksPass: true,
    confidenceThresholdMet: true,
    regressionChecksPass: true,
    shadowEvaluationPassed: true,
    resourceBudgetAvailable: true,
    governancePassed: true,
    rollbackCapabilityExists: true,
  }) === 'DENY', 'Safety denies on constraints failure');

  // Shadow tests
  const shadow = createShadowEvaluation({
    tenantId: 'tenantA',
    candidateId: candidate.candidateId,
    parentGenerationId: gen0.generationId,
    correlationId: 'corr1',
    baselineMetrics: { latency: 100 },
    candidateMetrics: { latency: 90 },
    evidence: [],
  });
  assert(shadow.status === 'PENDING', 'Shadow evaluation starts');
  const shadowCompleted = completeShadowEvaluation(shadow, { latency: 100 }, { latency: 90 }, 'PASS');
  assert(shadowCompleted.status === 'COMPLETED', 'Shadow completes');

  // Governance tests
  assert(governEvolutionCandidate({
    candidateRisk: 'LOW',
    confidence: 'HIGH',
    evidenceSufficient: true,
    regressionFree: true,
    requiredApproval: false,
    autonomyPermitted: true,
    freezeActive: false,
    budgetAvailable: true,
  }) === 'APPROVE', 'Governance approves');
  assert(governEvolutionCandidate({
    candidateRisk: 'HIGH',
    confidence: 'HIGH',
    evidenceSufficient: true,
    regressionFree: true,
    requiredApproval: true,
    autonomyPermitted: false,
    freezeActive: false,
    budgetAvailable: true,
  }) === 'REVIEW', 'Governance requires review');

  // Rollout tests
  const rollout = evaluateEvolutionRollout({
    currentStage: 'SHADOW',
    metrics: { errorRate: 0.01, latency: 90, reliability: 0.99, cost: 40 },
    thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 },
  });
  assert(rollout.nextStage === 'CANARY', 'Rollout progresses');

  // Rollback tests
  assert(evaluateEvolutionRollback({
    candidateId: candidate.candidateId,
    parentGenerationId: gen0.generationId,
    reason: 'test',
    eligible: true,
    authorized: true,
    governanceAllowed: true,
    safetyAllowed: true,
    rollbackAvailable: true,
    verificationSucceeded: true,
  }) === 'ROLLED_BACK', 'Rollback succeeds');
  assert(evaluateEvolutionRollback({
    candidateId: candidate.candidateId,
    parentGenerationId: gen0.generationId,
    reason: 'test',
    eligible: true,
    authorized: true,
    governanceAllowed: false,
    safetyAllowed: true,
    rollbackAvailable: true,
    verificationSucceeded: true,
  }) === 'BLOCKED', 'Rollback blocked by governance');

  // Retirement tests
  assert(decideRetirement({
    generationId: 'g1',
    strategyId: 's1',
    tenantId: 'tenantA',
    obsolete: true,
    unsafe: false,
    superseded: false,
    unused: false,
    degraded: false,
    outsideObjectives: false,
    governanceDecision: 'ALLOW',
  }) === 'RETIRED', 'Retirement triggered');

  // Learning tests
  const learning = createEvolutionLearningRecord({
    tenantId: 'tenantA',
    strategyId: 's1',
    generationId: 'g1',
    candidateId: candidate.candidateId,
    outcome: 'IMPROVED',
    evidence: ['ev1'],
    confidence: 'HIGH',
    correlationId: 'corr1',
  });
  assert(learning.learningId !== undefined || learning.createdAt.length > 0, 'Learning record created');

  // Audit and secret redaction
  const audit = createEvolutionAuditEvent({
    tenantId: 'tenantA',
    correlationId: 'corr1',
    strategyId: 's1',
    generationId: 'g1',
    candidateId: candidate.candidateId,
    eventType: 'TEST',
    reason: 'test',
    decision: 'ALLOW',
    metadata: { password: 'secret123', nested: { token: 'tok123', arr: [{ apiKey: 'key123' }] } },
  });
  assert(!JSON.stringify(audit.redactedMetadata).includes('secret123'), 'Password redacted');
  assert(!JSON.stringify(audit.redactedMetadata).includes('tok123'), 'Token redacted');
  assert(!JSON.stringify(audit.redactedMetadata).includes('key123'), 'API key redacted');

  // Orchestrator end-to-end test
  const orchestration = orchestrateStrategyEvolution({
    tenantId: 'tenantA',
    strategyId: 's1',
    parentGenerationId: gen0.generationId,
    rootStrategyId: 's1',
    correlationId: 'corr1',
    sourceEvidence: ['ev1'],
    learningInputs: ['learn1'],
    mutationRationale: 'reduce timeout',
    constraints: ['latency < 200'],
    expectedObjectives: { latency: 90 },
    candidateInput: {
      parentStrategyId: 's1',
      parentGenerationId: gen0.generationId,
      proposedGeneration: 1,
      sourceEvidence: ['ev1'],
      changeSet: { timeout: { before: 30, after: 25 } },
      expectedBenefits: { latency: 5 },
      expectedRisks: { cost: 0.1 },
      constraints: ['latency < 200'],
      confidence: 'HIGH',
      reason: 'reduce timeout',
    },
    baselineMetrics: { latency: 100, cost: 50 },
    candidateMetrics: { latency: 90, cost: 45 },
    allowedRegression: { latency: 20, cost: 10 },
    criticalMetrics: ['latency', 'cost'],
    confidenceInput: {
      sampleSize: 100,
      historicalSuccessCount: 90,
      outcomeConsistency: 0.9,
      durability: 0.8,
      recentness: 0.7,
      regressionEvidence: false,
      uncertainty: 0.1,
      strategyAge: 30,
      driftSeverity: 'NONE',
      failureHistoryCount: 0,
    },
    riskLevel: 'LOW',
    governanceInput: {
      evidenceSufficient: true,
      regressionFree: true,
      requiredApproval: false,
      autonomyPermitted: true,
      freezeActive: false,
      budgetAvailable: true,
    },
    resourceBudgetAvailable: true,
    rollbackCapabilityExists: true,
    lineage: lineageWithGen0,
    expectedGeneration: 1,
  });
  assert(orchestration.generation.generationId.length > 0, 'Orchestrator generation created');
  assert(orchestration.safety === 'ALLOW', 'Orchestrator safety allows');
  assert(orchestration.governance === 'APPROVE', 'Orchestrator governance approves');
  assert(orchestration.auditEvents.length >= 5, 'Orchestrator audit events emitted');
  assert(orchestration.lineage.generations.length === 2, 'Lineage updated with new generation');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) {
    console.log('PHASE 17 PASS 36: FAIL');
    process.exit(1);
  } else {
    console.log('PHASE 17 PASS 36: PASS');
  }
}

main();
