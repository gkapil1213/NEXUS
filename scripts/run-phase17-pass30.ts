import { createOptimizationHypothesis } from '../src/core/worker-optimization-hypothesis';
import { captureOptimizationBaseline } from '../src/core/worker-optimization-baseline';
import { createOptimizationExperiment } from '../src/core/worker-optimization-experiment';
import { evaluateStatistics } from '../src/core/worker-optimization-statistics';
import { orchestrateOptimization } from '../src/core/worker-autonomous-optimization-orchestrator';
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
  console.log('=== Phase 17.30: Autonomous Production Optimization Experimentation, Decision Closure & Governed Closed-Loop Control ===');

  // Hypothesis tests
  const hypothesis = createOptimizationHypothesis({
    tenantId: 'tenantA',
    workerFleetId: 'fleet1',
    sourcePolicyVersion: 'v1',
    objective: 'COST',
    baselineMetrics: { cost: 100, latency: 50 },
    expectedImprovement: { cost: 10 },
    maximumAcceptableRegression: { latency: 60 },
    riskLevel: 'LOW',
    confidenceRequirement: 'MEDIUM',
    experimentScope: 'FLEET',
    correlationId: 'corr1',
  });
  assert(hypothesis.hypothesisId.length > 0, 'Hypothesis created');
  assert(hypothesis.objective === 'COST', 'Objective set');
  assert(hypothesis.riskLevel === 'LOW', 'Risk level set');

  const duplicateHypothesis = createOptimizationHypothesis({
    tenantId: 'tenantA',
    workerFleetId: 'fleet1',
    sourcePolicyVersion: 'v1',
    objective: 'COST',
    baselineMetrics: { cost: 100 },
    expectedImprovement: { cost: 10 },
    maximumAcceptableRegression: { latency: 60 },
    riskLevel: 'LOW',
    confidenceRequirement: 'MEDIUM',
    experimentScope: 'FLEET',
    correlationId: 'corr1',
  });
  assert(duplicateHypothesis.idempotencyKey === hypothesis.idempotencyKey, 'Duplicate hypothesis same idempotency key');

  // Baseline tests
  const baseline = captureOptimizationBaseline({
    tenantId: 'tenantA',
    hypothesisId: hypothesis.hypothesisId,
    baselineVersion: 'b1',
    baselineWindow: { start: '2025-01-01', end: '2025-01-15' },
    metrics: { cost: 100, latency: 50 },
    telemetryFreshness: 'FRESH',
    policyVersion: 'v1',
    fleetState: 'healthy',
    incidentState: 'none',
    releaseState: 'none',
    correlationId: 'corr1',
  });
  assert(baseline.baselineId.length > 0, 'Baseline captured');
  assert(baseline.telemetryFreshness === 'FRESH', 'Baseline telemetry fresh');
  assert(baseline.metrics.cost === 100, 'Baseline cost correct');

  // Experiment tests
  const experiment = createOptimizationExperiment({
    tenantId: 'tenantA',
    hypothesisId: hypothesis.hypothesisId,
    mode: 'CANARY',
    treatmentGroup: 'groupA',
    allocationPercent: 10,
    startTime: new Date().toISOString(),
    maximumDurationHours: 24,
    minimumSampleSize: 100,
    maximumBlastRadius: 20,
    abortThresholds: { errorRate: 0.05 },
    successThresholds: { costReduction: 10 },
    correlationId: 'corr1',
  });
  assert(experiment.experimentId.length > 0, 'Experiment created');
  assert(experiment.mode === 'CANARY', 'Experiment mode set');
  assert(experiment.status === 'CREATED', 'Experiment initial status');

  // Statistics tests
  assert(evaluateStatistics({
    sampleSize: 200,
    minimumSampleSize: 100,
    observationWindowDays: 14,
    minimumObservationWindowDays: 7,
    confidenceThreshold: 0.95,
    effectSize: 0.2,
    minimumEffectSize: 0.1,
    regressionDetected: false,
    telemetryFresh: true,
    confidenceLevel: 0.98,
  }) === 'STATISTICALLY_SUPPORTED', 'Statistics supported');

  assert(evaluateStatistics({
    sampleSize: 50,
    minimumSampleSize: 100,
    observationWindowDays: 14,
    minimumObservationWindowDays: 7,
    confidenceThreshold: 0.95,
    effectSize: 0.2,
    minimumEffectSize: 0.1,
    regressionDetected: false,
    telemetryFresh: true,
    confidenceLevel: 0.98,
  }) === 'INSUFFICIENT_DATA', 'Statistics insufficient data');

  assert(evaluateStatistics({
    sampleSize: 200,
    minimumSampleSize: 100,
    observationWindowDays: 14,
    minimumObservationWindowDays: 7,
    confidenceThreshold: 0.95,
    effectSize: 0.2,
    minimumEffectSize: 0.1,
    regressionDetected: true,
    telemetryFresh: true,
    confidenceLevel: 0.98,
  }) === 'REGRESSION', 'Statistics regression');

  // Orchestrator test (success path)
  const orchestratorResult = orchestrateOptimization({
    hypothesis: {
      tenantId: 'tenantA',
      workerFleetId: 'fleet1',
      sourcePolicyVersion: 'v1',
      objective: 'COST',
      baselineMetrics: { cost: 100, latency: 50 },
      expectedImprovement: { cost: 10 },
      maximumAcceptableRegression: { latency: 60 },
      riskLevel: 'LOW',
      confidenceRequirement: 'MEDIUM',
      experimentScope: 'FLEET',
      correlationId: 'corr1',
    },
    baseline: {
      baselineVersion: 'b1',
      baselineWindow: { start: '2025-01-01', end: '2025-01-15' },
      metrics: { cost: 100, latency: 50 },
      telemetryFreshness: 'FRESH',
      policyVersion: 'v1',
      fleetState: 'healthy',
      incidentState: 'none',
      releaseState: 'none',
    },
    experiment: {
      mode: 'CANARY',
      treatmentGroup: 'groupA',
      allocationPercent: 10,
      startTime: new Date().toISOString(),
      maximumDurationHours: 24,
      minimumSampleSize: 100,
      maximumBlastRadius: 20,
      abortThresholds: { errorRate: 0.05 },
      successThresholds: { costReduction: 10 },
    },
    statistics: {
      sampleSize: 200,
      minimumSampleSize: 100,
      observationWindowDays: 14,
      minimumObservationWindowDays: 7,
      confidenceThreshold: 0.95,
      effectSize: 0.2,
      minimumEffectSize: 0.1,
      regressionDetected: false,
      telemetryFresh: true,
      confidenceLevel: 0.98,
    },
    attribution: {
      temporalOrdering: true,
      baselineMetrics: { errorRate: 0.01 },
      treatmentMetrics: { errorRate: 0.005 },
      controlMetrics: { errorRate: 0.012 },
      concurrentChanges: [],
      incidents: [],
      telemetryQuality: 'HIGH',
      observationWindowDays: 30,
    },
    safety: {
      riskLevel: 'LOW',
      confidence: 'HIGH',
      staleTelemetry: false,
      stalePolicy: false,
      staleAuthorization: false,
      missingRollback: false,
      blastRadiusExcessive: false,
      activeCriticalIncident: false,
      productionFreeze: false,
      dependencyFailure: false,
      insufficientEvidence: false,
      conflictingPolicyState: false,
    },
    governance: {
      riskLevel: 'LOW',
      confidence: 'HIGH',
      productionFreeze: false,
      activeIncident: false,
      cooldownSatisfied: true,
      blastRadiusAcceptable: true,
      dependencyHealthy: true,
      staleDecision: false,
      staleTelemetry: false,
      tenantIsolationValid: true,
    },
    rollout: {
      currentStage: 'CANARY',
      state: {
        errorRate: 0.01,
        latencyP95: 200,
        reliability: 0.99,
        cost: 100,
        rollbackRate: 0,
        incidentRate: 0,
      },
      thresholds: {
        maxErrorRate: 0.05,
        maxLatencyP95: 500,
        minReliability: 0.95,
        maxCost: 200,
        maxRollbackRate: 0.1,
        maxIncidentRate: 0.1,
      },
    },
    verification: {
      sampleSize: 100,
      baselineReliability: 0.95,
      actualReliability: 0.98,
      baselineCost: 100,
      actualCost: 90,
      baselinePerformance: 300,
      actualPerformance: 320,
      errorChange: -0.01,
      latencyChange: -10,
      incidentChange: 0,
      rollbackEvents: 0,
      telemetryFresh: true,
      conflictingMetrics: false,
    },
    promotion: {
      verificationResult: 'VERIFIED_IMPROVEMENT',
      confidence: 'HIGH',
      governanceDecision: 'ALLOW',
      safetyDecision: 'ALLOW',
      activeIncident: false,
      stableObservation: true,
      conflictingNewerPolicy: false,
      policyStillCurrent: true,
      cooldownSatisfied: true,
    },
    rollback: {
      previousKnownGoodVersion: 'v1',
      trigger: 'RELIABILITY_REGRESSION',
      duplicateRollback: false,
      rollbackAuthorized: true,
      rollbackAvailable: true,
      governanceAllowed: true,
      safetyAllowed: true,
      activeIncident: false,
      productionFreeze: false,
    },
  });

  assert(orchestratorResult.decision.outcome === 'PROMOTED', 'Orchestrator promotes on success');
  assert(orchestratorResult.auditEvents.length >= 3, 'Audit events created');
  assert(redactSecrets({ password: 'secret123', nested: { token: 'abc' } })['nested']['token'] === '[REDACTED]', 'Nested secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) {
    console.log('PHASE 17 PASS 30: FAIL');
    process.exit(1);
  } else {
    console.log('PHASE 17 PASS 30: PASS');
  }
}

main();
