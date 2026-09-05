import { attributeOutcome } from '../src/core/worker-policy-outcome-attribution';
import { evaluateEvolutionEffectiveness } from '../src/core/worker-policy-evolution-effectiveness';
import { learnFromOutcome } from '../src/core/worker-policy-outcome-learning';
import { generatePolicyEvolutionProposal } from '../src/core/worker-policy-evolution-proposal';
import { arbitrateObjectives } from '../src/core/worker-policy-objective-arbitrator';
import { detectPolicyEvolutionConflict } from '../src/core/worker-policy-evolution-conflict';
import { governPolicyEvolution } from '../src/core/worker-policy-evolution-governance';
import { evaluatePolicyEvolutionSafety } from '../src/core/worker-policy-evolution-safety-gate';
import { evaluateRollout } from '../src/core/worker-policy-evolution-rollout';
import { verifyPolicyOutcome } from '../src/core/worker-policy-evolution-verification';
import { evaluatePromotion } from '../src/core/worker-policy-promotion';
import { evaluateRollback } from '../src/core/worker-policy-evolution-rollback';
import { evaluatePolicyStability } from '../src/core/worker-policy-evolution-stability';
import { addVersionToLineage, PolicyLineage } from '../src/core/worker-policy-lineage';
import { createAuditEvent } from '../src/core/worker-policy-evolution-audit';
import { orchestratePolicyEvolution } from '../src/core/worker-policy-evolution-orchestrator';

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
  console.log('=== Phase 17.29: Autonomous Production Policy Evolution, Causal Outcome Intelligence & Safe Governed Optimization ===');

  // Attribution tests
  const attribution1 = attributeOutcome({
    temporalOrdering: true,
    baselineMetrics: { errorRate: 0.01 },
    treatmentMetrics: { errorRate: 0.005 },
    controlMetrics: { errorRate: 0.012 },
    concurrentChanges: [],
    incidents: [],
    telemetryQuality: 'HIGH',
    observationWindowDays: 30,
  });
  assert(attribution1.status === 'CAUSALLY_SUPPORTED', 'Causal attribution with control');

  const attribution2 = attributeOutcome({
    temporalOrdering: false,
    baselineMetrics: { errorRate: 0.01 },
    treatmentMetrics: { errorRate: 0.005 },
    concurrentChanges: [],
    incidents: [],
    telemetryQuality: 'HIGH',
    observationWindowDays: 30,
  });
  assert(attribution2.status === 'CORRELATED', 'Correlated only due to missing temporal ordering');

  const attribution3 = attributeOutcome({
    temporalOrdering: true,
    baselineMetrics: { errorRate: 0.01 },
    treatmentMetrics: { errorRate: 0.02 },
    concurrentChanges: ['release-123'],
    incidents: [],
    telemetryQuality: 'HIGH',
    observationWindowDays: 30,
  });
  assert(attribution3.status === 'CONFOUNDED', 'Confounded due to concurrent changes');

  // Effectiveness tests
  assert(evaluateEvolutionEffectiveness({
    sampleSize: 100,
    successRate: 0.995,
    failureRate: 0.005,
    rollbackRate: 0,
    reliability: 0.99,
    telemetryFresh: true,
  }) === 'EFFECTIVE', 'Effective policy');

  assert(evaluateEvolutionEffectiveness({
    sampleSize: 100,
    successRate: 0.92,
    failureRate: 0.08,
    rollbackRate: 0.02,
    telemetryFresh: true,
  }) === 'DEGRADED', 'Degraded policy');

  assert(evaluateEvolutionEffectiveness({
    sampleSize: 5,
    successRate: 1,
    failureRate: 0,
    rollbackRate: 0,
    telemetryFresh: true,
  }) === 'INSUFFICIENT_DATA', 'Insufficient data');

  // Learning tests
  const learning1 = learnFromOutcome({
    outcome: 'VERIFIED_IMPROVEMENT',
    attributionStatus: 'CAUSALLY_SUPPORTED',
    confidence: 'HIGH',
    policyCharacteristics: { reliability: 0.99, cost: 100, performance: 500, risk: 0.2 },
    environmentalConstraints: ['production'],
  });
  assert(learning1.status === 'LEARNED', 'Successful outcome learning');

  const learning2 = learnFromOutcome({
    outcome: 'INSUFFICIENT_DATA',
    attributionStatus: 'INSUFFICIENT_DATA',
    confidence: 'UNKNOWN',
    policyCharacteristics: { reliability: 0, cost: 0, performance: 0, risk: 0 },
    environmentalConstraints: [],
  });
  assert(learning2.status === 'INSUFFICIENT_DATA', 'Learning with insufficient data');

  // Proposal tests
  const proposal1 = generatePolicyEvolutionProposal({
    tenantId: 'tenantA',
    policyId: 'policy1',
    sourceVersion: 'v1',
    proposedVersion: 'v2',
    rationale: 'Improve reliability',
    evidenceIds: ['ev1'],
    expectedImprovement: 'reliability',
    expectedRisk: 'LOW',
    expectedCostImpact: 'MEDIUM',
    expectedReliabilityImpact: 'HIGH',
    confidence: 'HIGH',
    rollbackPlan: 'Rollback to v1',
    rolloutPlan: 'Canary',
    expiry: '2025-12-31',
    activeIncident: false,
    productionFreeze: false,
    cooldownSatisfied: true,
    blastRadiusAcceptable: true,
    policyCurrent: true,
    duplicateCheck: false,
  });
  assert(proposal1 !== null && proposal1.status === 'PROPOSED', 'Valid proposal generated');

  const proposal2 = generatePolicyEvolutionProposal({
    tenantId: 'tenantA',
    policyId: 'policy1',
    sourceVersion: 'v1',
    proposedVersion: 'v2',
    rationale: 'Duplicate',
    evidenceIds: [],
    expectedImprovement: '',
    expectedRisk: 'LOW',
    expectedCostImpact: 'LOW',
    expectedReliabilityImpact: 'LOW',
    confidence: 'HIGH',
    rollbackPlan: '',
    rolloutPlan: '',
    expiry: '',
    activeIncident: false,
    productionFreeze: false,
    cooldownSatisfied: true,
    blastRadiusAcceptable: true,
    policyCurrent: true,
    duplicateCheck: true,
  });
  assert(proposal2 === null, 'Duplicate proposal rejected');

  // Arbitration tests
  const arb1 = arbitrateObjectives({
    tenantId: 't',
    policyId: 'p',
    impacts: [
      { objective: 'RELIABILITY', impact: 'POSITIVE' },
      { objective: 'COST', impact: 'NEGATIVE' },
    ],
  });
  assert(arb1.decision === 'DENY', 'Arbitration denies on negative reliability');

  const arb2 = arbitrateObjectives({
    tenantId: 't',
    policyId: 'p',
    impacts: [
      { objective: 'PERFORMANCE', impact: 'POSITIVE' },
      { objective: 'COST', impact: 'POSITIVE' },
    ],
  });
  assert(arb2.decision === 'ALLOW', 'Arbitration allows when no negative impacts');

  // Conflict tests
  const conflict1 = detectPolicyEvolutionConflict({
    tenantId: 't',
    policyId: 'p',
    sourceVersion: 'v1',
    proposedVersion: 'v2',
    activeProposals: [{ policyId: 'p', proposedVersion: 'v2', status: 'ACTIVE' }],
    activeRecovery: false,
    activeRelease: false,
    activeOptimization: false,
    staleProposal: false,
    dependencyConflict: false,
    tenantScopeConflict: false,
  });
  assert(conflict1 === 'ALLOW', 'No conflict');

  const conflict2 = detectPolicyEvolutionConflict({
    tenantId: 't',
    policyId: 'p',
    sourceVersion: 'v1',
    proposedVersion: 'v2',
    activeProposals: [{ policyId: 'p', proposedVersion: 'v3', status: 'ACTIVE' }],
    activeRecovery: false,
    activeRelease: false,
    activeOptimization: false,
    staleProposal: false,
    dependencyConflict: false,
    tenantScopeConflict: false,
  });
  assert(conflict2 === 'CONFLICTED', 'Conflicting proposal detected');

  // Governance tests
  assert(governPolicyEvolution({
    tenantId: 't',
    policyId: 'p',
    policyVersion: 'v1',
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
  }) === 'ALLOW', 'Governance allows');

  assert(governPolicyEvolution({
    tenantId: 't',
    policyId: 'p',
    policyVersion: 'v1',
    riskLevel: 'LOW',
    confidence: 'HIGH',
    productionFreeze: true,
    activeIncident: false,
    cooldownSatisfied: true,
    blastRadiusAcceptable: true,
    dependencyHealthy: true,
    staleDecision: false,
    staleTelemetry: false,
    tenantIsolationValid: true,
  }) === 'DENY', 'Governance denies during freeze');

  // Safety tests
  assert(evaluatePolicyEvolutionSafety({
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
  }) === 'ALLOW', 'Safety allows');

  assert(evaluatePolicyEvolutionSafety({
    riskLevel: 'CRITICAL',
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
  }) === 'DENY', 'Safety denies critical risk');

  // Rollout tests
  const rollout1 = evaluateRollout({
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
  });
  assert(rollout1.nextStage === 'LIMITED', 'Rollout progresses to next stage');

  const rollout2 = evaluateRollout({
    currentStage: 'LIMITED',
    state: {
      errorRate: 0.2,
      latencyP95: 600,
      reliability: 0.9,
      cost: 300,
      rollbackRate: 0.2,
      incidentRate: 0.2,
    },
    thresholds: {
      maxErrorRate: 0.05,
      maxLatencyP95: 500,
      minReliability: 0.95,
      maxCost: 200,
      maxRollbackRate: 0.1,
      maxIncidentRate: 0.1,
    },
  });
  assert(rollout2.nextStage === 'HOLD', 'Rollout holds on threshold violation');

  // Verification tests
  assert(verifyPolicyOutcome({
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
  }) === 'VERIFIED_IMPROVEMENT', 'Verified improvement');

  assert(verifyPolicyOutcome({
    sampleSize: 100,
    baselineReliability: 0.95,
    actualReliability: 0.90,
    baselineCost: 100,
    actualCost: 120,
    baselinePerformance: 300,
    actualPerformance: 280,
    errorChange: 0.05,
    latencyChange: 20,
    incidentChange: 1,
    rollbackEvents: 1,
    telemetryFresh: true,
    conflictingMetrics: false,
  }) === 'VERIFIED_REGRESSION', 'Verified regression');

  // Promotion tests
  assert(evaluatePromotion({
    tenantId: 't',
    policyId: 'p',
    currentVersion: 'v1',
    proposedVersion: 'v2',
    verificationResult: 'VERIFIED_IMPROVEMENT',
    confidence: 'HIGH',
    governanceDecision: 'ALLOW',
    safetyDecision: 'ALLOW',
    activeIncident: false,
    stableObservation: true,
    conflictingNewerPolicy: false,
    policyStillCurrent: true,
    cooldownSatisfied: true,
  }) === 'PROMOTED', 'Promotion allowed');

  assert(evaluatePromotion({
    tenantId: 't',
    policyId: 'p',
    currentVersion: 'v1',
    proposedVersion: 'v2',
    verificationResult: 'VERIFIED_REGRESSION',
    confidence: 'HIGH',
    governanceDecision: 'ALLOW',
    safetyDecision: 'ALLOW',
    activeIncident: false,
    stableObservation: true,
    conflictingNewerPolicy: false,
    policyStillCurrent: true,
    cooldownSatisfied: true,
  }) === 'DENIED', 'Promotion denied on regression');

  // Rollback tests
  assert(evaluateRollback({
    tenantId: 't',
    policyId: 'p',
    currentVersion: 'v2',
    previousKnownGoodVersion: 'v1',
    trigger: 'RELIABILITY_REGRESSION',
    duplicateRollback: false,
    rollbackAuthorized: true,
    rollbackAvailable: true,
    governanceAllowed: true,
    safetyAllowed: true,
    activeIncident: false,
    productionFreeze: false,
  }) === 'ALLOWED', 'Rollback allowed');

  // Stability tests
  assert(evaluatePolicyStability({
    recentPolicyChanges: 1,
    recentRollbacks: 0,
    recentFailedRollouts: 0,
    cooldownActive: false,
    minObservationWindowSatisfied: true,
    oscillationDetected: false,
    adaptationFrequencyExceeded: false,
    rollbackFrequencyExceeded: false,
    telemetryFresh: true,
  }) === 'STABLE', 'Stable policy');

  assert(evaluatePolicyStability({
    recentPolicyChanges: 10,
    recentRollbacks: 5,
    recentFailedRollouts: 5,
    cooldownActive: true,
    minObservationWindowSatisfied: false,
    oscillationDetected: true,
    adaptationFrequencyExceeded: true,
    rollbackFrequencyExceeded: true,
    telemetryFresh: true,
  }) === 'THRASHING', 'Thrashing detected');

  // Lineage test
  const lineage: PolicyLineage = {
    policyId: 'p',
    tenantId: 't',
    versions: [],
  };
  try {
    const newLineage = addVersionToLineage(lineage, {
      version: 'v1',
      parentVersion: null,
      reason: 'initial',
      evidenceIds: [],
      status: 'ACTIVE',
      timestamp: '2025-01-01',
    });
    assert(newLineage.versions.length === 1, 'Lineage adds version');
    try {
      addVersionToLineage(newLineage, {
        version: 'v1',
        parentVersion: null,
        reason: 'duplicate',
        evidenceIds: [],
        status: 'ACTIVE',
        timestamp: '2025-01-02',
      });
      assert(false, 'Duplicate version should throw');
    } catch {
      assert(true, 'Duplicate version throws correctly');
    }
  } catch {
    assert(false, 'Lineage add version failed');
  }

  // Audit test (secret redaction)
  const auditEvent = createAuditEvent({
    tenantId: 't',
    correlationId: 'c',
    policyId: 'p',
    policyVersion: 'v1',
    eventType: 'TEST_EVENT',
    result: 'OK',
    reason: 'Testing',
    metadata: { password: 'secret123', nested: { token: 'abc' } },
  });
  assert(!JSON.stringify(auditEvent.redactedMetadata).includes('secret123'), 'Audit redacts password');
  assert(!JSON.stringify(auditEvent.redactedMetadata).includes('abc'), 'Audit redacts token');

  // Orchestrator smoke test
  const orchestratorResult = orchestratePolicyEvolution({
    tenantId: 't',
    policyId: 'p',
    parentVersion: 'v1',
    proposedVersion: 'v2',
    decisionId: 'd1',
    learningCycleId: 'l1',
    correlationId: 'c1',
    workerScope: 'fleet',
    evidenceReferences: ['ev1'],
    baselinePeriod: { start: '2025-01-01', end: '2025-01-15' },
    treatmentPeriod: { start: '2025-01-16', end: '2025-01-31' },
    expectedOutcome: 'Improved reliability',
    actualOutcome: 'Improved',
    confidence: 'HIGH',
    risk: 'LOW',
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
    effectiveness: {
      sampleSize: 100,
      successRate: 0.995,
      failureRate: 0.005,
      rollbackRate: 0,
      reliability: 0.99,
      telemetryFresh: true,
    },
    proposal: {
      rationale: 'Improve reliability',
      evidenceIds: ['ev1'],
      expectedImprovement: 'reliability',
      expectedRisk: 'LOW',
      expectedCostImpact: 'MEDIUM',
      expectedReliabilityImpact: 'HIGH',
      rollbackPlan: 'Rollback to v1',
      rolloutPlan: 'Canary',
      expiry: '2025-12-31',
      activeIncident: false,
      productionFreeze: false,
      cooldownSatisfied: true,
      blastRadiusAcceptable: true,
      policyCurrent: true,
      duplicateCheck: false,
    },
    arbitration: {
      impacts: [
        { objective: 'RELIABILITY', impact: 'POSITIVE' },
        { objective: 'COST', impact: 'NEUTRAL' },
      ],
    },
    conflict: {
      activeProposals: [],
      activeRecovery: false,
      activeRelease: false,
      activeOptimization: false,
      staleProposal: false,
      dependencyConflict: false,
      tenantScopeConflict: false,
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
    stability: {
      recentPolicyChanges: 1,
      recentRollbacks: 0,
      recentFailedRollouts: 0,
      cooldownActive: false,
      minObservationWindowSatisfied: true,
      oscillationDetected: false,
      adaptationFrequencyExceeded: false,
      rollbackFrequencyExceeded: false,
      telemetryFresh: true,
    },
  });
  assert(orchestratorResult.governance === 'ALLOW', 'Orchestrator governance allow');
  assert(orchestratorResult.safety === 'ALLOW', 'Orchestrator safety allow');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) {
    console.log('PHASE 17 PASS 29: FAIL');
    process.exit(1);
  } else {
    console.log('PHASE 17 PASS 29: PASS');
  }
}

main();
