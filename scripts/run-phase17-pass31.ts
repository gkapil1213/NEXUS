import { createOptimizationPortfolio } from '../src/core/worker-optimization-portfolio';
import { validateObjectives } from '../src/core/worker-optimization-objectives';
import { classifyPareto } from '../src/core/worker-optimization-pareto';
import { createOptimizationCandidate } from '../src/core/worker-optimization-candidate';
import { detectInteraction } from '../src/core/worker-optimization-interaction';
import { createCrossExperimentLearningRecord } from '../src/core/worker-optimization-cross-experiment-learning';
import { arbitrateCandidate } from '../src/core/worker-optimization-arbitrator';
import { createResourceBudget, reserveResource, releaseResource } from '../src/core/worker-optimization-resource-budget';
import { scheduleCandidate } from '../src/core/worker-optimization-scheduler';
import { governPortfolio } from '../src/core/worker-optimization-portfolio-governance';
import { evaluatePortfolioSafety } from '../src/core/worker-optimization-portfolio-safety';
import { evaluatePortfolioRollout } from '../src/core/worker-optimization-portfolio-rollout';
import { evaluatePortfolioRollback } from '../src/core/worker-optimization-portfolio-rollback';
import { closePortfolio } from '../src/core/worker-optimization-portfolio-closure';
import { evaluatePortfolioStability } from '../src/core/worker-optimization-portfolio-stability';
import { addPortfolioVersion, PortfolioLineage } from '../src/core/worker-optimization-portfolio-lineage';
import { createPortfolioAuditEvent } from '../src/core/worker-optimization-portfolio-audit';
import { orchestratePortfolio } from '../src/core/worker-autonomous-optimization-portfolio-orchestrator';
import { redactSecrets } from '../src/core/secret-redaction';
import { evaluateStatistics } from '../src/core/worker-optimization-statistics';

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
  console.log('=== Phase 17.31: Autonomous Production Optimization Portfolio, Cross-Experiment Learning & Governed Multi-Objective Control ===');

  // Portfolio
  const portfolio = createOptimizationPortfolio({
    tenantId: 'tenantA',
    objectiveSet: ['COST', 'LATENCY'],
    candidates: [],
    experiments: [],
    policyVersions: [],
    state: 'DRAFT',
    priority: 1,
    risk: 'LOW',
    expectedBenefit: 0,
    confidence: 'MEDIUM',
    resourceRequirements: { CPU: 2 },
    dependencies: [],
    conflicts: [],
    correlationId: 'corr1',
  });
  assert(portfolio.portfolioId.length > 0, 'Portfolio created');
  assert(portfolio.tenantId === 'tenantA', 'Tenant set');

  const duplicatePortfolio = createOptimizationPortfolio({
    tenantId: 'tenantA',
    objectiveSet: ['COST', 'LATENCY'],
    candidates: [],
    experiments: [],
    policyVersions: [],
    state: 'DRAFT',
    priority: 1,
    risk: 'LOW',
    expectedBenefit: 0,
    confidence: 'MEDIUM',
    resourceRequirements: { CPU: 2 },
    dependencies: [],
    conflicts: [],
    correlationId: 'corr1',
  });
  assert(duplicatePortfolio.idempotencyKey === portfolio.idempotencyKey, 'Duplicate portfolio same idempotency key');

  // Objectives validation
  assert(validateObjectives([
    { name: 'COST', target: 80, currentValue: 100, baseline: 100, direction: 'MINIMIZE', weight: 0.5, tolerance: 10, hardConstraint: false, priority: 1 },
    { name: 'LATENCY', target: 50, currentValue: 60, baseline: 60, direction: 'MINIMIZE', weight: 0.5, tolerance: 10, hardConstraint: false, priority: 2 },
  ]).valid, 'Valid objectives pass');
  assert(!validateObjectives([
    { name: 'COST', target: 80, currentValue: 100, baseline: 100, direction: 'MINIMIZE', weight: 0.6, tolerance: 10, hardConstraint: false, priority: 1 },
    { name: 'LATENCY', target: 50, currentValue: 60, baseline: 60, direction: 'MINIMIZE', weight: 0.5, tolerance: 10, hardConstraint: false, priority: 2 },
  ]).valid, 'Invalid weights fail');
  assert(!validateObjectives([
    { name: 'SECURITY', target: 1, currentValue: 1, baseline: 1, direction: 'MAXIMIZE', weight: 0, tolerance: 0, hardConstraint: true, priority: 0 },
  ]).valid, 'Hard constraint with zero weight fails');

  // Pareto
  const paretoCandidates = [
    { id: 'a', metrics: { cost: 10, latency: 20 }, hardConstraintsViolated: false },
    { id: 'b', metrics: { cost: 15, latency: 15 }, hardConstraintsViolated: false },
    { id: 'c', metrics: { cost: 8, latency: 25 }, hardConstraintsViolated: false },
    { id: 'd', metrics: { cost: 9, latency: 19 }, hardConstraintsViolated: false },
    { id: 'e', metrics: { cost: 20, latency: 10 }, hardConstraintsViolated: true },
  ];
  assert(classifyPareto(paretoCandidates[0], paretoCandidates) === 'NON_DOMINATED', 'Candidate a non-dominated');
  assert(classifyPareto(paretoCandidates[3], paretoCandidates) === 'DOMINATED', 'Candidate d dominated by a');
  assert(classifyPareto(paretoCandidates[4], paretoCandidates) === 'INFEASIBLE', 'Hard constraint violation gives infeasible');

  // Candidate
  const candidate = createOptimizationCandidate({
    tenantId: 'tenantA',
    source: 'policy-learning',
    sourceVersion: 'v1',
    objectiveImpact: { cost: -5, latency: 2 },
    expectedBenefit: 0.3,
    confidence: 'HIGH',
    risk: 'LOW',
    requiredEvidence: ['ev1'],
    dependencies: [],
    conflicts: [],
    rollbackPlan: 'rollback to v1',
    correlationId: 'corr1',
  });
  assert(candidate.candidateId.length > 0, 'Candidate created');
  assert(candidate.sourceVersion === 'v1', 'Source version set');

  // Interaction detection
  assert(detectInteraction({ candidateA: 'a', candidateB: 'b', sharedMetrics: { cost: 1, latency: 1 }, hardConstraintViolation: false, conflict: false, dependencyConflict: false, rolloutCollision: false }) === 'POSITIVE_SYNERGY', 'Positive synergy detected');
  assert(detectInteraction({ candidateA: 'a', candidateB: 'b', sharedMetrics: { cost: -1 }, hardConstraintViolation: false, conflict: true, dependencyConflict: false, rolloutCollision: false }) === 'NEGATIVE_INTERACTION', 'Negative interaction due to conflict');
  assert(detectInteraction({ candidateA: 'a', candidateB: 'b', sharedMetrics: {}, hardConstraintViolation: true, conflict: false, dependencyConflict: false, rolloutCollision: false }) === 'UNSAFE', 'Unsafe interaction due to hard constraint');

  // Cross-experiment learning
  const learning = createCrossExperimentLearningRecord({
    tenantId: 'tenantA',
    strategy: 'reduce-idle',
    objectiveImpacts: { cost: -10, latency: 5 },
    evidenceType: 'CAUSALLY_SUPPORTED',
    experimentIds: ['exp1'],
    correlationId: 'corr1',
  });
  assert(learning.timestamp.length > 0, 'Cross-experiment learning record created');
  assert(learning.evidenceType === 'CAUSALLY_SUPPORTED', 'Evidence type set');

  // Arbitration
  assert(arbitrateCandidate({ candidateRisk: 'LOW', confidence: 'HIGH', expectedBenefit: 0.2, hardConstraintViolation: false, activeIncident: false, productionFreeze: false, insufficientEvidence: false, resourceOvercommit: false, conflictDetected: false }) === 'ACCEPT', 'Arbitration accepts');
  assert(arbitrateCandidate({ candidateRisk: 'LOW', confidence: 'HIGH', expectedBenefit: 0.2, hardConstraintViolation: true, activeIncident: false, productionFreeze: false, insufficientEvidence: false, resourceOvercommit: false, conflictDetected: false }) === 'REJECT', 'Arbitration rejects hard constraint violation');
  assert(arbitrateCandidate({ candidateRisk: 'CRITICAL', confidence: 'HIGH', expectedBenefit: 0.2, hardConstraintViolation: false, activeIncident: false, productionFreeze: false, insufficientEvidence: false, resourceOvercommit: false, conflictDetected: false }) === 'REQUIRE_HUMAN_APPROVAL', 'Arbitration requires human approval for critical risk');
  assert(arbitrateCandidate({ candidateRisk: 'LOW', confidence: 'LOW', expectedBenefit: 0.2, hardConstraintViolation: false, activeIncident: false, productionFreeze: false, insufficientEvidence: false, resourceOvercommit: false, conflictDetected: false }) === 'REQUIRE_EVIDENCE', 'Arbitration requires evidence for low confidence');

  // Resource budget
  let budget = createResourceBudget('tenantA', { CPU: 10, MEMORY: 100 });
  const res1 = reserveResource(budget, 'CPU', 5);
  assert(res1.success, 'Resource reservation succeeds');
  budget = res1.budget;
  assert(budget.reserved['CPU'] === 5, 'Reserved amount correct');
  const res2 = reserveResource(budget, 'CPU', 6);
  assert(!res2.success, 'Overcommitment rejected');
  budget = releaseResource(budget, 'CPU', 2);
  assert(budget.reserved['CPU'] === 3, 'Release reduces reservation');

  // Scheduling
  assert(scheduleCandidate({ candidateId: 'c1', tenantId: 'tenantA', dependencies: [], conflicts: [], risk: 'LOW', activeIncident: false, productionFreeze: false, resourceAvailable: true, concurrentExperiments: 0, maxConcurrentExperiments: 5 }, []) === 'RUN_NOW', 'Scheduling runs candidate');
  assert(scheduleCandidate({ candidateId: 'c2', tenantId: 'tenantA', dependencies: ['c1'], conflicts: [], risk: 'LOW', activeIncident: false, productionFreeze: false, resourceAvailable: true, concurrentExperiments: 0, maxConcurrentExperiments: 5 }, []) === 'QUEUE', 'Scheduling queues due to missing dependency');
  assert(scheduleCandidate({ candidateId: 'c3', tenantId: 'tenantA', dependencies: [], conflicts: ['c1'], risk: 'LOW', activeIncident: false, productionFreeze: false, resourceAvailable: true, concurrentExperiments: 0, maxConcurrentExperiments: 5 }, ['c1']) === 'BLOCK', 'Scheduling blocks due to conflict');

  // Governance
  assert(governPortfolio({ tenantId: 'tenantA', portfolioRisk: 'LOW', activeIncident: false, productionFreeze: false, insufficientEvidence: false, hardConstraintViolation: false, resourceOvercommit: false, dependencyFailure: false, tenantIsolationValid: true }) === 'ALLOW', 'Governance allows');
  assert(governPortfolio({ tenantId: 'tenantA', portfolioRisk: 'LOW', activeIncident: true, productionFreeze: false, insufficientEvidence: false, hardConstraintViolation: false, resourceOvercommit: false, dependencyFailure: false, tenantIsolationValid: true }) === 'OBSERVE_ONLY', 'Governance observe during incident');
  assert(governPortfolio({ tenantId: 'tenantA', portfolioRisk: 'LOW', activeIncident: false, productionFreeze: true, insufficientEvidence: false, hardConstraintViolation: false, resourceOvercommit: false, dependencyFailure: false, tenantIsolationValid: true }) === 'DENY', 'Governance denies during freeze');

  // Safety
  assert(evaluatePortfolioSafety({ risk: 'LOW', activeCriticalIncident: false, productionFreeze: false, staleTelemetry: false, dependencyFailure: false, excessiveBlastRadius: false, insufficientEvidence: false, securityViolation: false }) === 'ALLOW', 'Safety allows');
  assert(evaluatePortfolioSafety({ risk: 'LOW', activeCriticalIncident: true, productionFreeze: false, staleTelemetry: false, dependencyFailure: false, excessiveBlastRadius: false, insufficientEvidence: false, securityViolation: false }) === 'DENY', 'Safety denies during critical incident');
  assert(evaluatePortfolioSafety({ risk: 'LOW', activeCriticalIncident: false, productionFreeze: false, staleTelemetry: true, dependencyFailure: false, excessiveBlastRadius: false, insufficientEvidence: false, securityViolation: false }) === 'DEFER', 'Safety defers on stale telemetry');

  // Rollout
  assert(evaluatePortfolioRollout({ currentStage: 'CANARY', experimentHealth: [{ criticalRegression: false, anyRegression: false, safetyCompromised: false }], thresholds: { criticalErrorRate: 0.05, maxRegressionRatio: 0.5 } }) === 'LIMITED', 'Rollout advances');
  assert(evaluatePortfolioRollout({ currentStage: 'LIMITED', experimentHealth: [{ criticalRegression: false, anyRegression: true, safetyCompromised: false }], thresholds: { criticalErrorRate: 0.05, maxRegressionRatio: 0.5 } }) === 'PORTFOLIO_HOLD', 'Rollout holds on regression');
  assert(evaluatePortfolioRollout({ currentStage: 'PROGRESSIVE', experimentHealth: [{ criticalRegression: true, anyRegression: true, safetyCompromised: true }], thresholds: { criticalErrorRate: 0.05, maxRegressionRatio: 0.5 } }) === 'ROLLBACK_PORTFOLIO', 'Rollout triggers rollback on critical regression');

  // Rollback
  assert(evaluatePortfolioRollback({ scope: 'PORTFOLIO_ROLLBACK', tenantId: 'tenantA', portfolioId: 'p1', currentVersion: 'v2', targetKnownGoodVersion: 'v1', duplicateRollback: false, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true }) === 'ALLOWED', 'Rollback allowed');
  assert(evaluatePortfolioRollback({ scope: 'PORTFOLIO_ROLLBACK', tenantId: 'tenantA', portfolioId: 'p1', currentVersion: 'v2', targetKnownGoodVersion: 'v1', duplicateRollback: true, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true }) === 'DEFERRED', 'Duplicate rollback deferred');

  // Closure
  assert(closePortfolio({ allExperimentsSucceeded: true, anyCriticalRegression: false, insufficientEvidence: false, governanceAllowed: true, safetyAllowed: true }) === 'PROMOTED', 'Closure promotes');
  assert(closePortfolio({ allExperimentsSucceeded: false, anyCriticalRegression: true, insufficientEvidence: false, governanceAllowed: true, safetyAllowed: true }) === 'ROLLED_BACK', 'Closure rolls back on regression');
  assert(closePortfolio({ allExperimentsSucceeded: true, anyCriticalRegression: false, insufficientEvidence: true, governanceAllowed: true, safetyAllowed: true }) === 'INSUFFICIENT_EVIDENCE', 'Closure insufficient evidence');

  // Stability
  assert(evaluatePortfolioStability({ promoteCount: 1, rollbackCount: 0, oscillationDetected: false, repeatedRollback: false, telemetryFresh: true, cooldownActive: false }) === 'STABLE', 'Stability stable');
  assert(evaluatePortfolioStability({ promoteCount: 5, rollbackCount: 5, oscillationDetected: true, repeatedRollback: true, telemetryFresh: true, cooldownActive: false }) === 'THRASHING', 'Thrashing detected');

  // Lineage
  const lineage: PortfolioLineage = { portfolioId: 'p1', tenantId: 'tenantA', versions: [] };
  const lineageV1 = addPortfolioVersion(lineage, { version: '1', parentVersion: null, reason: 'initial', candidateIds: [], experimentIds: [], correlationId: 'corr1', timestamp: '2025-01-01', status: 'ACTIVE' });
  assert(lineageV1.versions.length === 1, 'Lineage adds version');
  try {
    addPortfolioVersion(lineageV1, { version: '1', parentVersion: null, reason: 'duplicate', candidateIds: [], experimentIds: [], correlationId: 'corr1', timestamp: '2025-01-01', status: 'ACTIVE' });
    assert(false, 'Duplicate lineage version should throw');
  } catch {
    assert(true, 'Duplicate lineage version throws');
  }

  // Audit + secret redaction
  const audit = createPortfolioAuditEvent({
    tenantId: 'tenantA',
    correlationId: 'corr1',
    entityId: 'p1',
    entityVersion: '1',
    eventType: 'PORTFOLIO_CREATED',
    reason: 'created',
    decision: 'DRAFT',
    metadata: { password: 'secret123', nested: { token: 'abc' } },
  });
  assert(!JSON.stringify(audit.redactedMetadata).includes('secret123'), 'Audit redacts password');
  assert(!JSON.stringify(audit.redactedMetadata).includes('abc'), 'Audit redacts nested token');

  // Orchestrator smoke test
  const objectives = [
    { name: 'COST', target: 80, currentValue: 100, baseline: 100, direction: 'MINIMIZE', weight: 0.5, tolerance: 10, hardConstraint: false, priority: 1 },
    { name: 'LATENCY', target: 50, currentValue: 60, baseline: 60, direction: 'MINIMIZE', weight: 0.5, tolerance: 10, hardConstraint: false, priority: 2 },
  ];
  const candidatesData = [
    {
      source: 'policy-learning',
      sourceVersion: 'v1',
      objectiveImpact: { cost: -5, latency: 2 },
      expectedBenefit: 0.3,
      confidence: 'HIGH',
      risk: 'LOW',
      requiredEvidence: ['ev1'],
      dependencies: [],
      conflicts: [],
      rollbackPlan: 'rollback to v1',
    },
  ];
  const governanceInput = {
    tenantId: 'tenantA',
    portfolioRisk: 'LOW',
    activeIncident: false,
    productionFreeze: false,
    insufficientEvidence: false,
    hardConstraintViolation: false,
    resourceOvercommit: false,
    dependencyFailure: false,
    tenantIsolationValid: true,
  };
  const safetyInput = {
    risk: 'LOW',
    activeCriticalIncident: false,
    productionFreeze: false,
    staleTelemetry: false,
    dependencyFailure: false,
    excessiveBlastRadius: false,
    insufficientEvidence: false,
    securityViolation: false,
  };
  const rolloutInput = {
    currentStage: 'CANARY',
    experimentHealth: [{ criticalRegression: false, anyRegression: false, safetyCompromised: false }],
    thresholds: { criticalErrorRate: 0.05, maxRegressionRatio: 0.5 },
  };
  const rollbackInput = {
    scope: 'PORTFOLIO_ROLLBACK',
    tenantId: 'tenantA',
    portfolioId: 'p1',
    currentVersion: 'v2',
    targetKnownGoodVersion: 'v1',
    duplicateRollback: false,
    rollbackAuthorized: true,
    governanceAllowed: true,
    safetyAllowed: true,
    rollbackAvailable: true,
  };
  const closureInput = {
    allExperimentsSucceeded: true,
    anyCriticalRegression: false,
    insufficientEvidence: false,
    governanceAllowed: true,
    safetyAllowed: true,
  };
  const stabilityInput = {
    promoteCount: 1,
    rollbackCount: 0,
    oscillationDetected: false,
    repeatedRollback: false,
    telemetryFresh: true,
    cooldownActive: false,
  };
  const orchestration = orchestratePortfolio({
    tenantId: 'tenantA',
    correlationId: 'corr1',
    objectives,
    candidates: candidatesData,
    resourceLimits: { CPU: 10 },
    resourceRequests: { CPU: 2 },
    governance: governanceInput,
    safety: safetyInput,
    rollout: rolloutInput,
    rollback: rollbackInput,
    closure: closureInput,
    stability: stabilityInput,
  });

  assert(orchestration.portfolio.portfolioId.length > 0, 'Orchestrator created portfolio');
  assert(orchestration.governance === 'ALLOW', 'Orchestrator governance allow');
  assert(orchestration.safety === 'ALLOW', 'Orchestrator safety allow');
  assert(orchestration.closure === 'PROMOTED', 'Orchestrator closure promoted');
  assert(orchestration.auditEvents.length >= 4, 'Orchestrator audit events emitted');

  // Regression check Phase 17.30
  assert(evaluateStatistics({ sampleSize: 200, minimumSampleSize: 100, observationWindowDays: 14, minimumObservationWindowDays: 7, confidenceThreshold: 0.95, effectSize: 0.2, minimumEffectSize: 0.1, regressionDetected: false, telemetryFresh: true, confidenceLevel: 0.98 }) === 'STATISTICALLY_SUPPORTED', 'Phase 17.30 statistics regression check');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) {
    console.log('PHASE 17 PASS 31: FAIL');
    process.exit(1);
  } else {
    console.log('PHASE 17 PASS 31: PASS');
  }
}

main();
