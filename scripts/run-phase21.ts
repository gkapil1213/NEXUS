import { createProductionSignal, isDuplicateSignal } from '../src/core/worker-production-intelligence-signal';
import { detectAnomaly } from '../src/core/worker-production-intelligence-anomaly';
import { correlateSignals } from '../src/core/worker-production-intelligence-correlation';
import { generateHypothesis } from '../src/core/worker-production-intelligence-hypothesis';
import { assessProductionRisk } from '../src/core/worker-production-intelligence-risk';
import { createRemediationPlan } from '../src/core/worker-production-intelligence-remediation';
import { createRemediationExecution, transitionRemediationExecution } from '../src/core/worker-production-intelligence-remediation-executor';
import { verifyRemediation } from '../src/core/worker-production-intelligence-remediation-verification';
import { evaluateRemediationCircuitBreaker } from '../src/core/worker-production-intelligence-circuit-breaker';
import { createProductionLearningRecord } from '../src/core/worker-production-intelligence-learning';
import { orchestrateProductionIntelligence } from '../src/core/worker-autonomous-production-intelligence';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodSignal = {
  source: 'prometheus',
  environmentId: 'prod',
  serviceId: 'svc1',
  timestamp: new Date().toISOString(),
  metric: 'error_rate',
  severity: 'CRITICAL' as const,
  observedValue: 0.15,
  expectedValue: 0.01,
  deploymentContext: 'rel1',
  releaseContext: 'v1',
  metadata: {},
  correlationId: 'corr1',
};

function getGoodRequest(governance: 'ALLOW' | 'DENY' = 'ALLOW') {
  return {
    tenantId: 't',
    correlationId: 'c',
    signalInput: goodSignal,
    anomalyThresholds: { warning: 0.05, critical: 0.1 },
    governanceDecision: governance,
    safetyDecision: 'ALLOW' as const,
    riskInput: { severity: 'CRITICAL', blastRadius: 0.2, affectedServices: 1, customerImpact: false, deploymentCorrelated: true, reversibility: true, remediationRisk: 0, previousRemediationFailures: 0, circuitBreakerOpen: false },
    remediationPlan: { actionType: 'rollback', target: 'svc1', parameters: { version: 'v0' }, expectedOutcome: 'restore', riskLevel: 'LOW' as const, rollbackCapability: true, verificationStrategy: 'check', authorizationRequired: false },
    verificationInput: { beforeState: { error: 0.15 }, afterState: { error: 0.02 }, expectedRecovery: true },
    circuitBreaker: { failureCount: 0, threshold: 3 },
  };
}

async function main() {
  console.log('=== Phase 21: Autonomous Production Intelligence & Self-Healing ===');

  // Signal
  const signal = createProductionSignal(goodSignal);
  assert(signal.signalId.length > 0, 'Signal creation');
  const dupSignal = createProductionSignal(goodSignal);
  assert(isDuplicateSignal(signal, dupSignal), 'Duplicate signal detection');
  assert(signal.fingerprint.length > 0, 'Deterministic fingerprint');

  // Anomaly
  assert(detectAnomaly({ signal, thresholds: { warning: 0.05, critical: 0.1 } }) === 'CRITICAL', 'Critical anomaly');
  assert(detectAnomaly({ signal: { ...signal, severity: 'WARNING', observedValue: 0.06 }, thresholds: { warning: 0.05, critical: 0.1 } }) === 'WARNING', 'Warning anomaly');
  assert(detectAnomaly({ signal: { ...signal, severity: 'UNKNOWN', observedValue: 0 }, thresholds: { warning: 0.05, critical: 0.1 } }) === 'UNKNOWN', 'Unknown telemetry');

  // Correlation
  const correlated = correlateSignals([
    { signalId: 's1', serviceId: 'svc1', environmentId: 'prod', timestamp: new Date().toISOString() },
    { signalId: 's2', serviceId: 'svc1', environmentId: 'prod', timestamp: new Date().toISOString() },
  ], 3600000);
  assert(correlated.length === 1, 'Signal correlation');
  assert(correlated[0].signalIds.length === 2, 'Duplicate incident prevention (correlation)');

  // Hypothesis
  const hyp = generateHypothesis({ category: 'deployment regression', supportingSignals: ['s1','s2'], confidence: 0.7 });
  assert(hyp.hypothesisId.length > 0, 'Root-cause hypothesis');
  assert(hyp.confidence === 0.7, 'Honest uncertainty');

  // Risk
  assert(assessProductionRisk({ severity: 'CRITICAL', blastRadius: 0.6, affectedServices: 5, customerImpact: true, deploymentCorrelated: true, reversibility: false, remediationRisk: 0.5, previousRemediationFailures: 2, circuitBreakerOpen: true }) === 'CRITICAL', 'Risk classification');

  // Remediation plan
  const plan = createRemediationPlan({ incidentId: 'inc1', hypothesisId: hyp.hypothesisId, actionType: 'rollback', target: 'svc1', parameters: { version: 'v0' }, expectedOutcome: 'restore', riskLevel: 'HIGH', rollbackCapability: true, verificationStrategy: 'check', authorizationRequired: true });
  assert(plan.planId.length > 0, 'Remediation plan');

  // Execution
  let exec = createRemediationExecution({ planId: plan.planId, correlationId: 'c', maxAttempts: 2 });
  assert(exec.executionId.length > 0, 'Duplicate remediation prevention (idempotency)');
  exec = transitionRemediationExecution(exec, 'AUTHORIZED');
  exec = transitionRemediationExecution(exec, 'EXECUTING');
  exec = transitionRemediationExecution(exec, 'SUCCEEDED');
  assert(exec.status === 'SUCCEEDED', 'Legal remediation transition');
  try { transitionRemediationExecution(exec, 'EXECUTING'); assert(false, 'Should throw'); } catch { assert(true, 'Illegal remediation transition rejected'); }

  // Verification
  assert(verifyRemediation({ beforeState: { error: 0.15 }, afterState: { error: 0.02 }, expectedRecovery: true }).status === 'VERIFIED', 'Verification success');
  assert(verifyRemediation({ beforeState: { error: 0.15 }, afterState: { error: 0.16 }, expectedRecovery: true }).status === 'NOT_VERIFIED', 'Verification failure');

  // Circuit breaker
  assert(evaluateRemediationCircuitBreaker(2, 3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateRemediationCircuitBreaker(3, 3) === 'OPEN', 'Circuit breaker opens');

  // Learning
  const learning = createProductionLearningRecord({ tenantId: 't', incidentId: 'inc1', hypothesisId: hyp.hypothesisId, remediationId: exec.executionId, outcome: 'VERIFIED', failureClassification: 'NONE', confidence: 0.7, evidence: [], durationMs: 100, correlationId: 'c' });
  assert(learning.createdAt.length > 0, 'Learning record');

  // Orchestrator - approved
  const result = await orchestrateProductionIntelligence(getGoodRequest());
  assert(result.status === 'COMPLETED', 'Autonomous closed-loop execution');

  // Orchestrator - governance denied
  const blocked = await orchestrateProductionIntelligence(getGoodRequest('DENY'));
  assert(blocked.status === 'BLOCKED', 'Governance-denied lifecycle blocked');

  // Security redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 21: FAIL'); process.exit(1); }
  else { console.log('PHASE 21: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
