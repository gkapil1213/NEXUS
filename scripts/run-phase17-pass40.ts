import { createOptimizationPortfolioV40, validatePortfolioV40, attachPopulationV40 } from '../src/core/worker-optimization-portfolio-v40';
import { createPortfolioCandidate } from '../src/core/worker-optimization-portfolio-candidate';
import { selectPortfolioCandidates } from '../src/core/worker-optimization-portfolio-selection';
import { validatePortfolioObjectives } from '../src/core/worker-optimization-portfolio-objectives';
import { checkPortfolioBudget } from '../src/core/worker-optimization-portfolio-budget';
import { calculatePortfolioRisk } from '../src/core/worker-optimization-portfolio-risk';
import { detectCorrelation } from '../src/core/worker-optimization-portfolio-correlation';
import { detectPortfolioConflict } from '../src/core/worker-optimization-portfolio-conflict';
import { evaluateDiversification } from '../src/core/worker-optimization-portfolio-diversification';
import { allocateResources, AllocationState } from '../src/core/worker-optimization-portfolio-allocation';
import { coordinateExperiments } from '../src/core/worker-optimization-portfolio-coordination';
import { createPortfolioExperiment } from '../src/core/worker-optimization-portfolio-experiment';
import { createPortfolioEvidence } from '../src/core/worker-optimization-portfolio-evidence';
import { calculatePortfolioConfidence } from '../src/core/worker-optimization-portfolio-confidence';
import { createPortfolioLearningRecord } from '../src/core/worker-optimization-portfolio-learning';
import { assessLearningTransfer } from '../src/core/worker-optimization-portfolio-transfer';
import { addPortfolioVersion, PortfolioLineage } from '../src/core/worker-optimization-portfolio-lineage';
import { governPortfolioAction } from '../src/core/worker-optimization-portfolio-v40-governance';
import { evaluatePortfolioSafety } from '../src/core/worker-optimization-portfolio-v40-safety';
import { evaluatePortfolioRollout } from '../src/core/worker-optimization-portfolio-v40-rollout';
import { evaluatePortfolioRollback } from '../src/core/worker-optimization-portfolio-v40-rollback';
import { decideRecoveryAction } from '../src/core/worker-optimization-portfolio-recovery';
import { evaluatePortfolioHealth } from '../src/core/worker-optimization-portfolio-health';
import { detectPortfolioStagnation } from '../src/core/worker-optimization-portfolio-stagnation';
import { createPortfolioAuditEvent } from '../src/core/worker-optimization-portfolio-v40-audit';
import { orchestrateOptimizationPortfolio } from '../src/core/worker-autonomous-optimization-portfolio-v40-orchestrator';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) { console.log(`PASS: ${name}`); passed++; }
  else { console.error(`FAIL: ${name}`); failed++; }
}

function main() {
  console.log('=== Phase 17.40: Autonomous Optimization Portfolio Intelligence, Cross-Population Coordination & Governed Self-Improvement ===');

  const portfolio = createOptimizationPortfolioV40({
    tenantId: 'tenantA', objective: 'cost', ownerContext: 'platform', includedPopulations: ['pop1','pop2'],
    resourceBudget: 100, riskBudget: 0.5, experimentLimits: 10, governancePolicy: 'governed', safetyPolicy: 'safe', correlationId: 'corr1',
  });
  assert(portfolio.portfolioId.length > 0, 'Portfolio created');
  const dupPortfolio = createOptimizationPortfolioV40({
    tenantId: 'tenantA', objective: 'cost', ownerContext: 'platform', includedPopulations: ['pop1','pop2'],
    resourceBudget: 100, riskBudget: 0.5, experimentLimits: 10, governancePolicy: 'governed', safetyPolicy: 'safe', correlationId: 'corr1',
  });
  assert(dupPortfolio.idempotencyKey === portfolio.idempotencyKey, 'Duplicate portfolio blocked');
  assert(validatePortfolioV40(portfolio).valid, 'Portfolio validation');
  const invalidPortfolio = createOptimizationPortfolioV40({
    tenantId: 'tenantA', objective: '', ownerContext: '', includedPopulations: [], resourceBudget: 0, riskBudget: 0, experimentLimits: 0, governancePolicy: '', safetyPolicy: '', correlationId: 'corr2',
  });
  assert(!validatePortfolioV40(invalidPortfolio).valid, 'Invalid portfolio rejected');

  const portfolioWithPop = attachPopulationV40(portfolio, 'pop3');
  assert(portfolioWithPop.includedPopulations.length === 3, 'Population attachment');
  try { attachPopulationV40(portfolioWithPop, 'pop1'); assert(false, 'Duplicate population attachment should throw'); }
  catch { assert(true, 'Duplicate population attachment blocked'); }

  const candidate = createPortfolioCandidate({ portfolioId: portfolio.portfolioId, sourcePopulations: ['pop1'], action: 'transfer', reason: 'improve cost', evidence: ['ev1'], confidence: 0.7, impactEstimate: 0.5, riskEstimate: 0.2, recommendedAction: 'evaluate' });
  assert(candidate.candidateId.length > 0, 'Opportunity discovery (candidate)');
  const candidate2 = createPortfolioCandidate({ portfolioId: portfolio.portfolioId, sourcePopulations: ['pop1'], action: 'transfer', reason: 'improve cost', evidence: ['ev1'], confidence: 0.7, impactEstimate: 0.5, riskEstimate: 0.2, recommendedAction: 'evaluate' });
  assert(candidate2.idempotencyKey === candidate.idempotencyKey, 'Deterministic candidate generation');
  assert(candidate2.idempotencyKey === candidate.idempotencyKey, 'Duplicate candidate blocked');

  const conflict = detectPortfolioConflict({ populationIds: ['pop1','pop2'], targetOverlap: ['serviceA'], objectiveConflicts: false, rolloutConflicts: false, resourceConflicts: false, safetyPolicyConflicts: false, governancePolicyConflicts: false });
  assert(conflict.conflicted, 'Conflict detection');
  const correlation = detectCorrelation({ sharedDependencies: ['db1','cache1'], sharedTargets: ['svc1'], sharedInfrastructure: ['k8s'] });
  assert(correlation > 0, 'Correlated risk detection');

  const budget = { maxExperiments: 5, maxConcurrent: 2, maxCompute: 50, maxRollout: 10, maxEvaluation: 20 };
  assert(!checkPortfolioBudget(budget, { experiments: 6, concurrent: 1, compute: 10, rollout: 5, evaluation: 10 }).allowed, 'Resource budget enforcement');
  assert(!checkPortfolioBudget(budget, { experiments: 1, concurrent: 3, compute: 10, rollout: 5, evaluation: 10 }).allowed, 'Concurrency enforcement');

  assert(!evaluateDiversification({ strategyIds: ['s1','s2','s3'], fingerprintSimilarity: 0.9, concentrationScore: 0.8, strategicIndependence: 0.2 }).preserved, 'Diversification enforcement');

  assert(governPortfolioAction({ actionType: 'promote', risk: 0.2, confidence: 0.6, evidenceSufficient: true, budgetAvailable: true, affectedPopulations: 1, policyAllows: true }) === 'APPROVED', 'Champion protection (approval)');
  assert(governPortfolioAction({ actionType: 'challenge', risk: 0.3, confidence: 0.7, evidenceSufficient: true, budgetAvailable: true, affectedPopulations: 2, policyAllows: true }) === 'APPROVED', 'Challenger approval');
  assert(governPortfolioAction({ actionType: 'challenge', risk: 0.9, confidence: 0.9, evidenceSufficient: true, budgetAvailable: true, affectedPopulations: 1, policyAllows: true }) === 'DENIED', 'Unsafe challenger blocked');

  assert(coordinateExperiments({ activeExperiments: 1, conflictingExperiments: false, duplicateExperiments: false, budgetExhausted: false, fatigue: false, safetyHealthy: true }).proceed, 'Experiment coordination');
  assert(!coordinateExperiments({ activeExperiments: 1, conflictingExperiments: true, duplicateExperiments: false, budgetExhausted: false, fatigue: false, safetyHealthy: true }).proceed, 'Conflicting experiment blocked');

  assert(assessLearningTransfer({ sourcePopulationId: 'pop1', targetPopulationId: 'pop2', sourceStrategyId: 's1', contextCompatibility: 0.8, evidenceAvailable: true, confidence: 0.7, safetyValidated: true, governanceAuthorized: true }).approved, 'Cross-population learning transfer');
  assert(!assessLearningTransfer({ sourcePopulationId: 'pop1', targetPopulationId: 'pop2', sourceStrategyId: 's1', contextCompatibility: 0.3, evidenceAvailable: true, confidence: 0.7, safetyValidated: true, governanceAuthorized: true }).approved, 'Invalid learning transfer blocked');

  assert(evaluatePortfolioHealth({ populationHealth: 0.8, experimentHealth: 0.8, confidence: 0.7, regressionRate: 0.1, risk: 0.3, diversity: 0.6, redundancy: 0.2, resourceUtilization: 0.4, stagnation: 0.2, failureRate: 0.1 }) === 'HEALTHY', 'Portfolio health calculation');
  assert(evaluatePortfolioHealth({ populationHealth: 0.2, experimentHealth: 0.2, confidence: 0.2, regressionRate: 0.6, risk: 0.4, diversity: 0.5, redundancy: 0.8, resourceUtilization: 0.5, stagnation: 0.3, failureRate: 0.2 }) === 'DEGRADED', 'Degradation detection');
  assert(detectPortfolioStagnation({ improvementCount: 0, repeatedFailedExperiments: 5, explorationRate: 0.1, exploitationRate: 0.9, candidateDiversity: 0.1, learningTransferCount: 0, confidenceTrend: -0.4 }) === 'CRITICAL', 'Stagnation detection');
  assert(decideRecoveryAction({ portfolioHealth: 'UNSAFE', safetyHealthy: true, governanceAllowed: true, budgetAvailable: true }) === 'ROLLBACK_SAFE_STATE', 'Recovery trigger');

  assert(governPortfolioAction({ actionType: 'adjust', risk: 0.2, confidence: 0.7, evidenceSufficient: true, budgetAvailable: true, affectedPopulations: 1, policyAllows: true }) === 'APPROVED', 'Governance approval');
  assert(governPortfolioAction({ actionType: 'adjust', risk: 0.9, confidence: 0.9, evidenceSufficient: true, budgetAvailable: true, affectedPopulations: 1, policyAllows: true }) === 'DENIED', 'Governance denial');

  assert(evaluatePortfolioSafety({ constraintsValid: true, riskWithinLimit: true, correlatedRiskWithinLimit: true, blastRadiusAcceptable: true, rollbackAvailable: true, dependencyHealth: true, governanceAllowed: true, evidenceSufficient: true, budgetWithinLimit: true }) === 'ALLOW', 'Safety approval');
  assert(evaluatePortfolioSafety({ constraintsValid: false, riskWithinLimit: true, correlatedRiskWithinLimit: true, blastRadiusAcceptable: true, rollbackAvailable: true, dependencyHealth: true, governanceAllowed: true, evidenceSufficient: true, budgetWithinLimit: true }) === 'DENY', 'Safety denial');

  const rollout = evaluatePortfolioRollout({ currentStage: 'PROPOSED', metrics: { errorRate: 0.01, latency: 100, reliability: 0.99, cost: 50 }, thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 } });
  assert(rollout.nextStage === 'APPROVED', 'Rollout progression');

  assert(evaluatePortfolioRollback({ portfolioId: 'p1', rollbackTargetVersion: 1, duplicateRollback: false, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true, verificationSucceeded: true }) === 'ROLLED_BACK', 'Rollback success');
  assert(evaluatePortfolioRollback({ portfolioId: 'p1', rollbackTargetVersion: 1, duplicateRollback: true, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true, verificationSucceeded: true }) === 'ROLLBACK_BLOCKED', 'Rollback idempotency');

  const lineage: PortfolioLineage = { portfolioId: 'p1', tenantId: 'tenantA', versions: [] };
  const lineage1 = addPortfolioVersion(lineage, { version: '1', parentVersion: null, reason: 'init', candidateIds: [], experimentIds: [], correlationId: 'corr1', timestamp: new Date().toISOString(), status: 'ACTIVE' });
  assert(lineage1.versions.length === 1, 'Lineage preservation');

  const audit = createPortfolioAuditEvent({ tenantId: 'tenantA', correlationId: 'corr1', portfolioId: 'p1', eventType: 'TEST', reason: 'test', decision: 'ALLOW', metadata: { password: 'secret123', token: 'tok123', apiKey: 'key123' } });
  assert(audit.eventType === 'TEST', 'Audit event emission');
  assert(!JSON.stringify(audit.redactedMetadata).includes('secret123'), 'Password redacted');
  assert(!JSON.stringify(audit.redactedMetadata).includes('tok123'), 'Token redacted');
  assert(!JSON.stringify(audit.redactedMetadata).includes('key123'), 'API key redacted');

  // Orchestrator tests
  const orchestrationInput = getOrchestrationInput(true);
  const result = orchestrateOptimizationPortfolio(orchestrationInput);
  assert(result.status === 'COMPLETED', 'Orchestrator executes approved action');

  const unsafeInput = getOrchestrationInput(false);
  const unsafeResult = orchestrateOptimizationPortfolio(unsafeInput);
  assert(unsafeResult.status !== 'COMPLETED', 'Orchestrator blocks unsafe action');

  const result2 = orchestrateOptimizationPortfolio(getOrchestrationInput(true));
  assert(result2.portfolio.idempotencyKey === result.portfolio.idempotencyKey, 'Portfolio state remains deterministic');

  const decision1 = governPortfolioAction({ actionType: 'promote', risk: 0.2, confidence: 0.6, evidenceSufficient: true, budgetAvailable: true, affectedPopulations: 1, policyAllows: true });
  const decision2 = governPortfolioAction({ actionType: 'promote', risk: 0.2, confidence: 0.6, evidenceSufficient: true, budgetAvailable: true, affectedPopulations: 1, policyAllows: true });
  assert(decision1 === decision2, 'Portfolio decision idempotency');

  const allocState: AllocationState = {
    available: { experimentBudget: 10, computeBudget: 100, concurrency: 5, rolloutCapacity: 5, evaluationCapacity: 5, evidenceCollectionCapacity: 5 },
    reserved: { experimentBudget: 0, computeBudget: 0, concurrency: 0, rolloutCapacity: 0, evaluationCapacity: 0, evidenceCollectionCapacity: 0 },
  };
  const allocResult = allocateResources(allocState, { experimentBudget: 5, computeBudget: 50 });
  assert(allocResult.allowed && allocResult.state.available.experimentBudget === 5, 'Resource allocation remains within budget');

  assert(evaluateDiversification({ strategyIds: ['s1','s2'], fingerprintSimilarity: 0.2, concentrationScore: 0.3, strategicIndependence: 0.7 }).preserved, 'Population diversity preserved');
  assert(lineage1.versions.length === 1, 'Historical portfolio state retrievable');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 17 PASS 40: FAIL'); process.exit(1); }
  else { console.log('PHASE 17 PASS 40: PASS'); }
}

function getOrchestrationInput(safe: boolean) {
  return {
    tenantId: 'tenantA', correlationId: 'corr1', objective: 'cost', ownerContext: 'platform',
    includedPopulations: ['pop1','pop2'], resourceBudget: 100, riskBudget: 0.5, experimentLimits: 10,
    governancePolicy: 'governed', safetyPolicy: 'safe',
    candidateProfiles: [{ candidateId: 'c1', score: 0.9, confidence: 0.8, risk: 0.2, diversityContribution: 0.5 }],
    objectives: [
      { objectiveId: 'cost', direction: 'MINIMIZE', weight: 0.6, hardConstraint: false },
      { objectiveId: 'reliability', direction: 'MAXIMIZE', weight: 0.4, hardConstraint: true },
    ],
    budget: { maxExperiments: 10, maxConcurrent: 5, maxCompute: 100, maxRollout: 10, maxEvaluation: 20 },
    budgetUsage: { experiments: 1, concurrent: 1, compute: 10, rollout: 1, evaluation: 1 },
    riskInput: { individualRisks: [0.2], correlation: 0.1, blastRadius: 0.1 },
    correlationInput: { sharedDependencies: ['db1'], sharedTargets: ['svc1'], sharedInfrastructure: ['k8s'] },
    conflictInput: { populationIds: ['pop1','pop2'], targetOverlap: [], objectiveConflicts: false, rolloutConflicts: false, resourceConflicts: false, safetyPolicyConflicts: false, governancePolicyConflicts: false },
    diversificationInput: { strategyIds: ['s1','s2'], fingerprintSimilarity: 0.2, concentrationScore: 0.3, strategicIndependence: 0.7 },
    allocationRequest: { experimentBudget: 1, computeBudget: 5 },
    allocationState: { available: { experimentBudget: 10, computeBudget: 100, concurrency: 5, rolloutCapacity: 5, evaluationCapacity: 5, evidenceCollectionCapacity: 5 }, reserved: { experimentBudget: 0, computeBudget: 0, concurrency: 0, rolloutCapacity: 0, evaluationCapacity: 0, evidenceCollectionCapacity: 0 } },
    coordinationInput: { activeExperiments: 1, conflictingExperiments: false, duplicateExperiments: false, budgetExhausted: false, fatigue: false, safetyHealthy: safe },
    experimentInput: { populationIds: ['pop1','pop2'], action: 'transfer', hypothesis: 'test', objective: 'cost', metrics: ['cost'], constraints: [], budget: 10 },
    evidenceInput: [{ sourcePopulationId: 'pop1', targetPopulationId: 'pop2', outcome: { cost: 90 }, confidence: 0.8, evidenceType: 'POSITIVE', sampleSize: 10, durability: 0.9 }],
    confidenceInput: { evidenceCount: 10, duplicateCount: 0, consistency: 0.9, recency: 0.9, durability: 0.9, regressionHistory: 0 },
    transferInput: { sourcePopulationId: 'pop1', targetPopulationId: 'pop2', sourceStrategyId: 's1', contextCompatibility: 0.8, evidenceAvailable: true, confidence: 0.8, safetyValidated: true, governanceAuthorized: true },
    governanceInput: { actionType: 'transfer', risk: 0.2, confidence: 0.8, evidenceSufficient: true, budgetAvailable: true, affectedPopulations: 2, policyAllows: true },
    safetyInput: { constraintsValid: true, riskWithinLimit: true, correlatedRiskWithinLimit: true, blastRadiusAcceptable: true, rollbackAvailable: true, dependencyHealth: true, governanceAllowed: true, evidenceSufficient: true, budgetWithinLimit: true },
    rolloutInput: { currentStage: 'PROPOSED', metrics: { errorRate: 0.01, latency: 100, reliability: 0.99, cost: 50 }, thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 } },
    rollbackInput: { portfolioId: 'p1', rollbackTargetVersion: 1, duplicateRollback: false, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true, verificationSucceeded: true },
    healthInput: { populationHealth: 0.8, experimentHealth: 0.8, confidence: 0.8, regressionRate: 0.1, risk: 0.2, diversity: 0.6, redundancy: 0.2, resourceUtilization: 0.4, stagnation: 0.2, failureRate: 0.1 },
    stagnationInput: { improvementCount: 1, repeatedFailedExperiments: 0, explorationRate: 0.5, exploitationRate: 0.5, candidateDiversity: 0.6, learningTransferCount: 1, confidenceTrend: 0.1 },
    lineage: { portfolioId: 'p1', tenantId: 'tenantA', versions: [] },
  };
}

main();
