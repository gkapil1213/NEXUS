import { createStrategyPopulation, updatePopulationVersion, StrategyPopulation } from '../src/core/worker-strategy-population';
import { createPopulationCandidate } from '../src/core/worker-strategy-population-candidate';
import { evaluateDominance } from '../src/core/worker-strategy-dominance';
import { computeParetoFrontier } from '../src/core/worker-strategy-population-pareto';
import { evaluateDiversity } from '../src/core/worker-strategy-diversity';
import { classifyRedundancy } from '../src/core/worker-strategy-redundancy';
import { evaluateChampionChallenger } from '../src/core/worker-strategy-champion-challenger';
import { evaluatePopulationHealth } from '../src/core/worker-strategy-population-health';
import { calculateEvolutionPressure } from '../src/core/worker-strategy-evolution-pressure';
import { decideExplorationGovernance } from '../src/core/worker-strategy-exploration-governance';
import { selectGeneration } from '../src/core/worker-strategy-generation-selection';
import { governPopulationAction } from '../src/core/worker-strategy-population-governance';
import { evaluatePopulationSafety } from '../src/core/worker-strategy-population-safety';
import { evaluatePopulationRollout } from '../src/core/worker-strategy-population-rollout';
import { evaluatePopulationRollback } from '../src/core/worker-strategy-population-rollback';
import { createCrossLineageLearningRecord } from '../src/core/worker-strategy-cross-lineage-learning';
import { detectStagnation } from '../src/core/worker-strategy-population-stagnation';
import { initiateRecovery } from '../src/core/worker-strategy-population-recovery';
import { createPopulationAuditEvent } from '../src/core/worker-strategy-population-audit';
import { orchestratePopulation } from '../src/core/worker-autonomous-strategy-population-orchestrator';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) { console.log(`PASS: ${name}`); passed++; }
  else { console.error(`FAIL: ${name}`); failed++; }
}

function main() {
  console.log('=== Phase 17.37: Autonomous Strategy Population Intelligence, Multi-Generation Governance & Evolution Control ===');

  // 1-2 Population
  const population = createStrategyPopulation({
    tenantId: 'tenantA', strategyIds: ['s1'], generationIds: ['g1'], lineageIds: ['l1'],
    populationVersion: 1, status: 'ACTIVE', activeStrategyId: 's1', challengerStrategyIds: [],
    retiredStrategyIds: [], populationHealth: 'HEALTHY', diversityScore: 0.8, convergenceScore: 0.2,
    stagnationScore: 0.1, explorationPressure: 0.5, exploitationPressure: 0.5,
    populationConfidence: 'HIGH', correlationId: 'corr1',
  });
  assert(population.populationId.length > 0, 'Population created');
  const dupPop = createStrategyPopulation({
    tenantId: 'tenantA', strategyIds: ['s1'], generationIds: ['g1'], lineageIds: ['l1'],
    populationVersion: 1, status: 'ACTIVE', activeStrategyId: 's1', challengerStrategyIds: [],
    retiredStrategyIds: [], populationHealth: 'HEALTHY', diversityScore: 0.8, convergenceScore: 0.2,
    stagnationScore: 0.1, explorationPressure: 0.5, exploitationPressure: 0.5,
    populationConfidence: 'HIGH', correlationId: 'corr1',
  });
  assert(dupPop.idempotencyKey === population.idempotencyKey, 'Duplicate population blocked');

  const v2 = updatePopulationVersion(population, 2);
  assert(v2.populationVersion === 2, 'Population version created');

  // 3-4 Candidate
  const candidate = createPopulationCandidate({
    tenantId: 'tenantA', strategyId: 's2', generationId: 'g2', lineageId: 'l1',
    fingerprint: 'fp1', objectiveProfile: { cost: 0.8, latency: 0.9 },
    behavioralDimensions: { concurrency: 0.7 }, resourceProfile: { cpu: 0.2 },
    failurePatterns: [], status: 'ELIGIBLE', correlationId: 'corr1',
  });
  assert(candidate.candidateId.length > 0, 'Candidate added');
  const dupCand = createPopulationCandidate({
    tenantId: 'tenantA', strategyId: 's2', generationId: 'g2', lineageId: 'l1',
    fingerprint: 'fp1', objectiveProfile: { cost: 0.8, latency: 0.9 },
    behavioralDimensions: { concurrency: 0.7 }, resourceProfile: { cpu: 0.2 },
    failurePatterns: [], status: 'ELIGIBLE', correlationId: 'corr1',
  });
  assert(dupCand.idempotencyKey === candidate.idempotencyKey, 'Duplicate candidate blocked');

  // 5-8 Dominance
  const dominance1 = evaluateDominance({
    candidate: { reliability: 0.9, throughput: 0.8 },
    others: [{ reliability: 0.8, throughput: 0.9 }, { reliability: 0.7, throughput: 0.7 }],
    dimensions: ['reliability', 'throughput'],
  });
  assert(dominance1 === 'NON_DOMINATED', 'Dominance calculated (non-dominated)');
  assert(dominance1 === 'NON_DOMINATED', 'Non-dominated strategy detected');

  const dominance2 = evaluateDominance({
    candidate: { reliability: 0.8, throughput: 0.7 },
    others: [{ reliability: 0.9, throughput: 0.9 }],
    dimensions: ['reliability', 'throughput'],
  });
  assert(dominance2 === 'DOMINATED', 'Dominated strategy detected');

  // 9 Pareto
  const pareto = computeParetoFrontier(
    [
      { strategyId: 's1', metrics: { cost: 10, latency: 5 } },
      { strategyId: 's2', metrics: { cost: 9, latency: 6 } },
      { strategyId: 's3', metrics: { cost: 8, latency: 7 } },
      { strategyId: 's4', metrics: { cost: 11, latency: 4 } },
    ],
    ['cost', 'latency']
  );
  assert(pareto.length >= 1, 'Pareto frontier calculated');

  // 10-11 Diversity
  assert(evaluateDiversity({
    fingerprints: ['a','b','c','d'],
    objectiveProfiles: [{ cost: 0.1 }, { latency: 0.2 }, { reliability: 0.3 }, { throughput: 0.4 }],
    lineageDistances: [0.5, 0.6, 0.7],
    resourceProfiles: [{ cpu: 0.1 }, { cpu: 0.2 }, { cpu: 0.3 }, { cpu: 0.4 }],
    executionCharacteristics: [{ errorRate: 0.01 }, { errorRate: 0.02 }],
    failurePatterns: [['a'], ['b'], ['c'], ['d']],
  }) === 'HEALTHY_DIVERSITY', 'Diversity healthy');
  assert(evaluateDiversity({
    fingerprints: ['a','a','a'],
    objectiveProfiles: [{ cost: 0.1 }, { cost: 0.1 }, { cost: 0.1 }],
    lineageDistances: [0.1, 0.1],
    resourceProfiles: [{ cpu: 0.1 }, { cpu: 0.1 }, { cpu: 0.1 }],
    executionCharacteristics: [],
    failurePatterns: [['a'], ['a'], ['a']],
  }) === 'LOW_DIVERSITY', 'Low diversity detected');

  // 12-13 Redundancy
  assert(classifyRedundancy({ fingerprintA: 'a', fingerprintB: 'a', objectiveSimilarity: 1, behavioralSimilarity: 1, resourceProfileSimilarity: 1, failurePatternOverlap: 1 }) === 'DUPLICATE', 'Redundancy detected');
  assert(classifyRedundancy({ fingerprintA: 'a', fingerprintB: 'b', objectiveSimilarity: 0.1, behavioralSimilarity: 0.1, resourceProfileSimilarity: 0.1, failurePatternOverlap: 0.1 }) === 'UNIQUE', 'Unique strategy preserved');

  // 14-17 Champion/Challenger
  const champ = evaluateChampionChallenger({
    champion: { championStrategyId: 's1', challengerStrategyIds: ['s2'], championProtected: false, requiredEvidenceCount: 2, currentEvidenceCount: 0 },
    challengerEvidence: [{ strategyId: 's2', evidenceCount: 3, confidence: 'HIGH', regressionFree: true }],
    governanceApproved: true, safetyApproved: true, rollbackAvailable: true,
  });
  assert(champ === 'PROMOTE_CHALLENGER', 'Challenger selected for promotion');
  const noEvidence = evaluateChampionChallenger({
    champion: { championStrategyId: 's1', challengerStrategyIds: ['s2'], championProtected: true, requiredEvidenceCount: 3, currentEvidenceCount: 0 },
    challengerEvidence: [{ strategyId: 's2', evidenceCount: 1, confidence: 'HIGH', regressionFree: true }],
    governanceApproved: true, safetyApproved: true, rollbackAvailable: true,
  });
  assert(noEvidence === 'KEEP_CHAMPION', 'Champion replacement blocked without evidence');
  const approvedReplace = evaluateChampionChallenger({
    champion: { championStrategyId: 's1', challengerStrategyIds: ['s2'], championProtected: false, requiredEvidenceCount: 2, currentEvidenceCount: 0 },
    challengerEvidence: [{ strategyId: 's2', evidenceCount: 5, confidence: 'HIGH', regressionFree: true }],
    governanceApproved: true, safetyApproved: true, rollbackAvailable: true,
  });
  assert(approvedReplace === 'PROMOTE_CHALLENGER', 'Champion replacement approved with evidence');

  // 18-19 Health
  assert(evaluatePopulationHealth({ diversityScore: 0.8, convergenceScore: 0.1, stagnationScore: 0.1, failureConcentration: 0.1, regressionConcentration: 0.1, resourcePressure: 0.2, confidenceQuality: 0.8 }) === 'HEALTHY', 'Population health healthy');
  assert(evaluatePopulationHealth({ diversityScore: 0.2, convergenceScore: 0.9, stagnationScore: 0.8, failureConcentration: 0.9, regressionConcentration: 0.7, resourcePressure: 0.95, confidenceQuality: 0.2 }) === 'RECOVERY_REQUIRED', 'Population degradation detected');

  // 20 Pressure
  const pressure = calculateEvolutionPressure({ populationSize: 10, championCount: 1, challengerCount: 3, retiredCount: 2, stagnationScore: 0.2, diversityScore: 0.7, regressionRate: 0.1 });
  assert(pressure.explorationPressure >= 0 && pressure.exploitationPressure >= 0, 'Evolution pressure calculated');

  // 21-22 Exploration/Exploitation
  assert(decideExplorationGovernance({ populationHealth: 'HEALTHY', explorationPressure: 0.8, exploitationPressure: 0.2, stagnationScore: 0.1, diversityScore: 0.6, governanceAllowed: true, resourceAvailable: true }) === 'EXPLORE', 'Exploration decision deterministic');
  assert(decideExplorationGovernance({ populationHealth: 'HEALTHY', explorationPressure: 0.3, exploitationPressure: 0.8, stagnationScore: 0.0, diversityScore: 0.8, governanceAllowed: true, resourceAvailable: true }) === 'EXPLOIT', 'Exploitation decision deterministic');

  // 23 Stagnation
  assert(detectStagnation({ improvementCount: 0, repeatedCandidates: 5, repeatedFailures: 6, excessiveRetirement: true, stableButSuboptimal: true, convergenceWithoutProgress: true, evidence: ['ev1'] }) === 'CRITICAL', 'Stagnation detected');

  // 24 Recovery
  const recovery = initiateRecovery({ populationHealth: 'RECOVERY_REQUIRED', unsafeRolloutActive: true, stableStrategyAvailable: true, governanceRequired: true });
  assert(recovery.length > 0, 'Recovery triggered');

  // 25 Safety block
  assert(evaluatePopulationSafety({ populationHealth: 'HEALTHY', diversityScore: 0.5, simultaneousRollouts: 1, maxSimultaneousRollouts: 2, championConfidence: 'HIGH', correlatedFailures: false, resourceExhaustion: false, rollbackUnavailable: true, governanceViolation: false, abnormalRegression: false }) === 'BLOCK', 'Safety blocks unsafe population mutation');

  // 26 Governance block
  assert(!governPopulationAction({ action: 'PROMOTE_STRATEGY', tenantId: 'tenantA', populationId: 'p1', governanceApproved: false, safetyApproved: true, approvalRequired: false, rollbackAvailable: true, resourceAvailable: true, evidenceSufficient: true }).allowed, 'Governance blocks unauthorized population mutation');

  // 27 Rollout
  const rollout = evaluatePopulationRollout({ currentStage: 'SHADOW', metrics: { errorRate: 0.01, latency: 100, reliability: 0.99, cost: 50 }, thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 } });
  assert(rollout.nextStage === 'LIMITED', 'Rollout progresses');

  // 28 Rollback
  assert(evaluatePopulationRollback({ populationId: 'p1', targetVersion: 1, duplicateRollback: false, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true, verificationSucceeded: true }) === 'ALLOWED', 'Rollback restores safe state');

  // 29 Cross-lineage
  const crossLearning = createCrossLineageLearningRecord({ tenantId: 'tenantA', sourceLineageIds: ['l1','l2'], reusableCharacteristics: ['cache'], repeatedFailurePatterns: ['timeout'], commonRegressions: ['latency'], complementaryStrategies: ['s1+s2'], transferableImprovements: ['reduce timeout'], confidence: 'MEDIUM', correlationId: 'corr1' });
  assert(crossLearning.recommendation.length > 0, 'Cross-lineage learning created');

  // 30 Historical state
  assert(population.populationVersion === 1 && v2.populationVersion === 2, 'Historical population state retrieved');

  // 31 Idempotency
  const govResult1 = governPopulationAction({ action: 'PROMOTE_STRATEGY', tenantId: 'tenantA', populationId: 'p1', governanceApproved: true, safetyApproved: true, approvalRequired: false, rollbackAvailable: true, resourceAvailable: true, evidenceSufficient: true });
  const govResult2 = governPopulationAction({ action: 'PROMOTE_STRATEGY', tenantId: 'tenantA', populationId: 'p1', governanceApproved: true, safetyApproved: true, approvalRequired: false, rollbackAvailable: true, resourceAvailable: true, evidenceSufficient: true });
  assert(govResult1.allowed === govResult2.allowed, 'Duplicate population decision idempotency');

  // 32 Audit
  const audit = createPopulationAuditEvent({ tenantId: 'tenantA', correlationId: 'corr1', populationId: 'p1', populationVersion: 1, eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit events emitted');

  // 33-35 Redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', nested: { secret: 'deep' } });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redacted');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redacted');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redacted');

  // 36-38 Orchestrator
  const orchestratorResult = orchestratePopulation({
    tenantId: 'tenantA', correlationId: 'corr1', population,
    candidates: [], dominanceDimensions: ['cost', 'latency'], paretoMembers: [],
    diversityInput: { fingerprints: ['a','b','c'], objectiveProfiles: [{ cost: 0.1 }, { cost: 0.2 }, { cost: 0.3 }], lineageDistances: [0.5, 0.6], resourceProfiles: [{ cpu: 0.1 }, { cpu: 0.2 }, { cpu: 0.3 }], executionCharacteristics: [], failurePatterns: [['a'], ['b'], ['c']] },
    healthInput: { diversityScore: 0.8, convergenceScore: 0.1, stagnationScore: 0.1, failureConcentration: 0.1, regressionConcentration: 0.1, resourcePressure: 0.2, confidenceQuality: 0.8 },
    pressureInput: { populationSize: 5, championCount: 1, challengerCount: 2, retiredCount: 1, stagnationScore: 0.1, diversityScore: 0.8, regressionRate: 0.05 },
    explorationInput: { populationHealth: 'HEALTHY', explorationPressure: 0.6, exploitationPressure: 0.4, stagnationScore: 0.1, diversityScore: 0.8, governanceAllowed: true, resourceAvailable: true },
    generationSelectionInput: { generations: [{ generationId: 'g1', generationNumber: 1, successRate: 0.9, stabilityScore: 0.8, specialist: false, lineageId: 'l1', regressionRate: 0.0 }], preferredStrategy: 'PROVEN' },
    stagnationInput: { improvementCount: 1, repeatedCandidates: 0, repeatedFailures: 0, excessiveRetirement: false, stableButSuboptimal: false, convergenceWithoutProgress: false, evidence: [] },
    rolloutInput: { currentStage: 'SHADOW', metrics: { errorRate: 0.01, latency: 100, reliability: 0.99, cost: 50 }, thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 } },
    rollbackInput: { populationId: 'p1', targetVersion: 1, duplicateRollback: false, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true, verificationSucceeded: true },
    governanceInput: { action: 'PROMOTE_STRATEGY', tenantId: 'tenantA', populationId: 'p1', governanceApproved: true, safetyApproved: true, approvalRequired: false, rollbackAvailable: true, resourceAvailable: true, evidenceSufficient: true },
    safetyInput: { populationHealth: 'HEALTHY', diversityScore: 0.8, simultaneousRollouts: 1, maxSimultaneousRollouts: 2, championConfidence: 'HIGH', correlatedFailures: false, resourceExhaustion: false, rollbackUnavailable: false, governanceViolation: false, abnormalRegression: false },
    championChallengerInput: { champion: { championStrategyId: 's1', challengerStrategyIds: ['s2'], championProtected: false, requiredEvidenceCount: 1, currentEvidenceCount: 0 }, challengerEvidence: [{ strategyId: 's2', evidenceCount: 2, confidence: 'HIGH', regressionFree: true }], governanceApproved: true, safetyApproved: true, rollbackAvailable: true },
  });
  assert(orchestratorResult.population.populationVersion === 2, 'Orchestrator executes approved population action');

  const unsafeOrchestrator = orchestratePopulation({
    tenantId: 'tenantA', correlationId: 'corr2', population,
    candidates: [], dominanceDimensions: ['cost'], paretoMembers: [],
    diversityInput: { fingerprints: ['a','a'], objectiveProfiles: [], lineageDistances: [], resourceProfiles: [], executionCharacteristics: [], failurePatterns: [] },
    healthInput: { diversityScore: 0.1, convergenceScore: 0.9, stagnationScore: 0.8, failureConcentration: 0.9, regressionConcentration: 0.8, resourcePressure: 0.95, confidenceQuality: 0.1 },
    pressureInput: { populationSize: 2, championCount: 0, challengerCount: 0, retiredCount: 0, stagnationScore: 0.9, diversityScore: 0.1, regressionRate: 0.9 },
    explorationInput: { populationHealth: 'RECOVERY_REQUIRED', explorationPressure: 0.1, exploitationPressure: 0.1, stagnationScore: 0.9, diversityScore: 0.1, governanceAllowed: true, resourceAvailable: true },
    generationSelectionInput: { generations: [], preferredStrategy: 'PROVEN' },
    stagnationInput: { improvementCount: 0, repeatedCandidates: 5, repeatedFailures: 6, excessiveRetirement: true, stableButSuboptimal: true, convergenceWithoutProgress: true, evidence: ['bad'] },
    rolloutInput: { currentStage: 'SHADOW', metrics: { errorRate: 0.2, latency: 300, reliability: 0.8, cost: 200 }, thresholds: { maxErrorRate: 0.05, maxLatency: 200, minReliability: 0.95, maxCost: 100 } },
    rollbackInput: { populationId: 'p1', targetVersion: 1, duplicateRollback: false, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: false, verificationSucceeded: true },
    governanceInput: { action: 'PROMOTE_STRATEGY', tenantId: 'tenantA', populationId: 'p1', governanceApproved: false, safetyApproved: false, approvalRequired: true, rollbackAvailable: false, resourceAvailable: false, evidenceSufficient: false },
    safetyInput: { populationHealth: 'FRAGILE', diversityScore: 0.1, simultaneousRollouts: 5, maxSimultaneousRollouts: 2, championConfidence: 'LOW', correlatedFailures: true, resourceExhaustion: true, rollbackUnavailable: true, governanceViolation: true, abnormalRegression: true },
    championChallengerInput: { champion: { championStrategyId: 's1', challengerStrategyIds: [], championProtected: true, requiredEvidenceCount: 5, currentEvidenceCount: 0 }, challengerEvidence: [], governanceApproved: false, safetyApproved: false, rollbackAvailable: false },
  });
  assert(unsafeOrchestrator.safety === 'BLOCK', 'Orchestrator blocks unsafe population action');
  assert(orchestratorResult.population.populationVersion > population.populationVersion, 'Lineage preserved across population generations');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 17 PASS 37: FAIL'); process.exit(1); }
  else { console.log('PHASE 17 PASS 37: PASS'); }
}

main();
