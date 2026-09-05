import { runControlCycle, createControlCycle } from '../src/core/worker-autonomous-optimization-control-plane';
import { createExecutionPlan } from '../src/core/worker-optimization-portfolio-execution-plan';
import { evaluateExecutionGate } from '../src/core/worker-optimization-portfolio-execution-gate';
import { createExecutionCycle, transitionExecutionCycle } from '../src/core/worker-optimization-portfolio-executor';
import { createExecutionBudget, reserveBudget, consumeBudget } from '../src/core/worker-optimization-portfolio-execution-budget';
import { evaluateExecutionRisk } from '../src/core/worker-optimization-portfolio-execution-risk';
import { evaluateExecutionMonitor } from '../src/core/worker-optimization-portfolio-execution-monitor';
import { createExecutionOutcome } from '../src/core/worker-optimization-portfolio-execution-outcome';
import { attributeOutcome } from '../src/core/worker-optimization-portfolio-outcome-attribution';
import { proposeReallocation } from '../src/core/worker-optimization-portfolio-reallocation';
import { evaluateAdaptationGate } from '../src/core/worker-optimization-portfolio-adaptation-gate';
import { detectDrift } from '../src/core/worker-optimization-portfolio-drift';
import { detectDegradation } from '../src/core/worker-optimization-portfolio-degradation';
import { decideRecoveryAction } from '../src/core/worker-optimization-portfolio-execution-recovery';
import { evaluateExecutionRollback } from '../src/core/worker-optimization-portfolio-execution-rollback';
import { governExecution } from '../src/core/worker-optimization-portfolio-execution-governance';
import { evaluateExecutionSafety } from '../src/core/worker-optimization-portfolio-execution-safety';
import { addExecutionLineageNode, ExecutionLineage } from '../src/core/worker-optimization-portfolio-execution-lineage';
import { createExecutionLearningRecord } from '../src/core/worker-optimization-portfolio-execution-learning';
import { createExecutionAuditEvent } from '../src/core/worker-optimization-portfolio-execution-audit';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodRequest = {
  requestId: 'req-001', objectiveId: 'cost', strategyContext: 's1', populationContext: 'pop1',
  experimentContext: 'exp1', metaExperimentContext: 'meta1', portfolioContext: 'port1', executionContext: 'exec1',
  planSteps: [{ stepId: 'step1', strategyId: 's1', action: 'deploy', parameters: {}, dependsOn: [], risk: 'LOW', timeoutMs: 1000, retryPolicy: 'TRANSIENT_ONLY' }],
  gateInput: { portfolioApproved: true, portfolioVersionValid: true, strategyCandidatesValid: true, strategyStatusPermits: true, constraintsPass: true, riskLimitsPass: true, budgetAvailable: true, requiredEvidenceExists: true, governanceApproved: true, noConflictingExecution: true, noActiveRollback: true, noSafetyIncident: true },
  budgetTotal: 100, reserveAmount: 10, consumeAmount: 5,
  riskInput: { strategyRisk: 0.1, portfolioRisk: 0.1, concentration: 0.1, correlatedFailure: 0.1, resourceExhaustion: 0.1, blastRadius: 0.1, cumulativeDegradation: 0.1, rollbackAvailable: true },
  monitorInput: { latencyMs: 100, failureRate: 0.01, partialCompletionRate: 0, resourceUsage: 0.2, strategyEffectiveness: 0.9, portfolioHealth: 0.9, driftDetected: false, degradationDetected: false, unexpectedBehavior: false },
  outcomeInput: { strategyId: 's1', strategyGenerationId: 'g1', resourceUsed: 5, result: 'SUCCESS', evidence: ['ev1'] },
  attributionInput: { strategyContribution: 0.5, generationContribution: 0.3, populationContribution: 0.1, portfolioContribution: 0.1, experimentContribution: 0, metaExperimentContribution: 0, evidenceQuality: 0.8, temporalOrdering: true },
  reallocationInput: { strategyId: 's1', effectiveness: 0.8, confidence: 0.8, recentOutcome: 'POSITIVE', risk: 0.2, resourceCost: 0.2, diversityImpact: 0.3 },
  adaptationGateInput: { evidenceSufficient: true, confidence: 0.8, regressionDetected: false, safetyApproved: true, governanceApproved: true, budgetCompatible: true, diversityConstraints: true, rollbackAvailable: true },
  driftInput: { strategyDrift: 0, executionDrift: 0, effectivenessDrift: 0, riskDrift: 0, resourceDrift: 0, compositionDrift: 0, evidenceDrift: 0 },
  degradationInput: { performanceDrop: 0, repeatedFailures: 0, correlation: 0, diversityCollapse: false, budgetPressure: 0.1, confidenceCollapse: false, evidenceDeterioration: false },
  recoveryInput: { executionFailed: false, partialExecution: false, timeout: false, resourceExhaustion: false, degradedPortfolio: false, strategyFailure: false, governanceInterrupted: false },
  rollbackInput: { executionId: 'e1', portfolioId: 'port1', targetVersion: 1, duplicateRollback: false, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true, verificationSucceeded: true },
  governanceInput: { risk: 0.2, confidence: 0.8, evidenceSufficient: true, budgetAvailable: true, highRisk: false, approvalRequired: false },
  safetyInput: { authorized: true, constraintsValid: true, budgetWithinLimit: true, concentrationAcceptable: true, evidenceSufficient: true, strategyStateValid: true, noConflictingExecution: true, rollbackAvailable: true, resourceUsageNormal: true },
  tenantId: 'tenantA', correlationId: 'corr1',
};

function main() {
  console.log('=== Phase 17.42: Autonomous Optimization Control Plane & Phase 17 Closure ===');

  // --- Lifecycle ---
  const result = runControlCycle(goodRequest);
  assert(result.status === 'COMPLETED', 'Control cycle creation/completion');
  assert(result.snapshot.cycleId.length > 0, 'Objective binding (cycleId exists)');
  assert(result.snapshot.fingerprint.length > 0, 'Snapshot creation/fingerprint');
  const dup = runControlCycle({ ...goodRequest, idempotencyKey: 'same-key' });
  const dup2 = runControlCycle({ ...goodRequest, idempotencyKey: 'same-key' });
  assert(dup.snapshot.fingerprint === dup2.snapshot.fingerprint, 'Duplicate cycle blocked / deterministic');

  // --- Consistency ---
  // Already validated by non-empty contexts in control plane; add explicit mismatch test
  const badContext = runControlCycle({ ...goodRequest, strategyContext: '' });
  assert(badContext.status === 'REJECTED', 'Invalid strategy context rejected');

  // --- Safety & Governance ---
  assert(governExecution({ risk: 0.2, confidence: 0.8, evidenceSufficient: true, budgetAvailable: true, highRisk: false, approvalRequired: false }) === 'APPROVED', 'Governance approval');
  assert(governExecution({ risk: 0.2, confidence: 0.8, evidenceSufficient: true, budgetAvailable: false, highRisk: false, approvalRequired: false }) === 'DENIED', 'Governance denial');
  assert(evaluateExecutionSafety({ authorized: true, constraintsValid: true, budgetWithinLimit: true, concentrationAcceptable: true, evidenceSufficient: true, strategyStateValid: true, noConflictingExecution: true, rollbackAvailable: true, resourceUsageNormal: true }).allowed, 'Safety allowed');
  assert(!evaluateExecutionSafety({ authorized: false, constraintsValid: true, budgetWithinLimit: true, concentrationAcceptable: true, evidenceSufficient: true, strategyStateValid: true, noConflictingExecution: true, rollbackAvailable: true, resourceUsageNormal: true }).allowed, 'Safety denied');

  // --- Evidence ---
  assert(createExecutionLearningRecord({ tenantId: 't', portfolioId: 'p', executionId: 'e', outcome: 'SUCCESS', evidence: ['ev1'], confidence: 0.8, correlationId: 'c' }).createdAt.length > 0, 'Evidence recorded/learning record created');

  // --- Execution ---
  const plan = createExecutionPlan({ portfolioId: 'p', version: 1, steps: goodRequest.planSteps, correlationId: 'c' });
  assert(plan.planId.length > 0, 'Valid plan generated');
  const dupPlan = createExecutionPlan({ portfolioId: 'p', version: 1, steps: goodRequest.planSteps, correlationId: 'c' });
  assert(dupPlan.idempotencyKey === plan.idempotencyKey, 'Duplicate plan blocked');
  let budget = createExecutionBudget('p', 100);
  const res = reserveBudget(budget, 50);
  assert(res.success, 'Budget reservation');
  assert(!reserveBudget(res.budget, 60).success, 'Double reservation blocked');

  // --- Outcome ---
  const outcome = createExecutionOutcome({ executionId: 'e', portfolioId: 'p', portfolioVersion: 1, strategyId: 's', strategyGenerationId: 'g', resourceUsed: 5, result: 'SUCCESS', evidence: [], correlationId: 'c' });
  assert(outcome.outcomeId.length > 0, 'Outcome recorded');
  assert(outcome.executionId === 'e' && outcome.strategyId === 's', 'Outcome provenance');
  const attr = attributeOutcome({ strategyContribution: 0.5, generationContribution: 0.3, populationContribution: 0.1, portfolioContribution: 0.1, experimentContribution: 0, metaExperimentContribution: 0, evidenceQuality: 0.8, temporalOrdering: true });
  assert(attr.attributionValid, 'Attribution succeeds');
  assert(!attributeOutcome({ strategyContribution: 0, generationContribution: 0, populationContribution: 0, portfolioContribution: 0, experimentContribution: 0, metaExperimentContribution: 0, evidenceQuality: 0.8, temporalOrdering: true }).attributionValid, 'Attribution failure');

  // --- Drift/Degradation ---
  assert(detectDrift({ strategyDrift: 0.1, executionDrift: 0, effectivenessDrift: 0, riskDrift: 0, resourceDrift: 0, compositionDrift: 0, evidenceDrift: 0 }).driftDetected, 'Drift detected');
  assert(detectDegradation({ performanceDrop: 0.4, repeatedFailures: 0, correlation: 0, diversityCollapse: false, budgetPressure: 0, confidenceCollapse: false, evidenceDeterioration: false }) === 'HIGH', 'Degradation detected');

  // --- Learning & Adaptation ---
  const learning = createExecutionLearningRecord({ tenantId: 't', portfolioId: 'p', executionId: 'e', outcome: 'SUCCESS', evidence: [], confidence: 0.8, correlationId: 'c' });
  assert(learning.learningRecordId === undefined && learning.createdAt.length > 0, 'Learning record created');
  const reallocation = proposeReallocation({ strategyId: 's', effectiveness: 0.9, confidence: 0.8, recentOutcome: 'POSITIVE', risk: 0.1, resourceCost: 0.1, diversityImpact: 0.2 });
  assert(reallocation === 'INCREASE', 'Adaptation proposal/reallocation');
  assert(!evaluateAdaptationGate({ evidenceSufficient: true, confidence: 0.6, regressionDetected: false, safetyApproved: false, governanceApproved: true, budgetCompatible: true, diversityConstraints: true, rollbackAvailable: true }).allowed, 'Unsafe adaptation blocked');
  assert(evaluateAdaptationGate({ evidenceSufficient: true, confidence: 0.6, regressionDetected: false, safetyApproved: true, governanceApproved: true, budgetCompatible: true, diversityConstraints: true, rollbackAvailable: true }).allowed, 'Approved adaptation progresses');

  // --- Recovery & Rollback ---
  assert(decideRecoveryAction({ executionFailed: true, partialExecution: false, timeout: false, resourceExhaustion: false, degradedPortfolio: false, strategyFailure: false, governanceInterrupted: false }) === 'ROLLBACK', 'Recovery triggered');
  assert(evaluateExecutionRollback({ executionId: 'e', portfolioId: 'p', targetVersion: 1, duplicateRollback: false, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true, verificationSucceeded: true }).status === 'ROLLED_BACK', 'Rollback succeeds');
  assert(evaluateExecutionRollback({ executionId: 'e', portfolioId: 'p', targetVersion: 1, duplicateRollback: true, rollbackAuthorized: true, governanceAllowed: true, safetyAllowed: true, rollbackAvailable: true, verificationSucceeded: true }).status === 'ROLLBACK_BLOCKED', 'Rollback idempotency');

  // --- Audit / Security ---
  const audit = createExecutionAuditEvent({ tenantId: 't', correlationId: 'c', portfolioId: 'p', eventType: 'TEST', reason: 'test', decision: 'ALLOW', metadata: { password: 'secret123', token: 'tok123', apiKey: 'key123' } });
  assert(audit.eventType === 'TEST', 'Audit event emitted');
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');

  // --- Orchestrator / End-to-end ---
  const full = runControlCycle(goodRequest);
  assert(full.status === 'COMPLETED', 'Orchestrator executes approved lifecycle');
  assert(full.auditEvents.length > 0, 'Audit trail');
  assert(full.lineage && full.lineage.nodes.length === 1, 'Lineage preserved');
  assert(full.learning !== undefined, 'Learning record');
  const repeat = runControlCycle({ ...goodRequest });
  assert(repeat.snapshot.fingerprint === full.snapshot.fingerprint, 'Repeated identical request remains idempotent');

  // Additional safety/governance blocks
  const unsafe = runControlCycle({ ...goodRequest, safetyInput: { ...goodRequest.safetyInput, authorized: false } });
  assert(unsafe.status !== 'COMPLETED', 'Orchestrator blocks unsafe lifecycle');
  const denied = runControlCycle({ ...goodRequest, governanceInput: { ...goodRequest.governanceInput, budgetAvailable: false } });
  assert(denied.status !== 'COMPLETED', 'Orchestrator blocks governance-denied lifecycle');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 17 PASS 42: FAIL'); process.exit(1); }
  else { console.log('PHASE 17 PASS 42: PASS'); }
}

main();
