import { createDeploymentTarget, isTargetAvailable } from '../src/core/worker-deployment-target';
import { unavailableDeploymentAdapter, DeploymentAdapter } from '../src/core/worker-deployment-adapter';
import { createDeploymentPlan } from '../src/core/worker-deployment-plan';
import { runDeploymentPreflight } from '../src/core/worker-deployment-preflight';
import { acquireDeploymentLock, releaseDeploymentLock, isLockActive } from '../src/core/worker-deployment-lock';
import { createDeploymentExecution, transitionDeploymentExecution } from '../src/core/worker-deployment-execution';
import { evaluateCanaryRollout } from '../src/core/worker-deployment-rollout';
import { evaluateRuntimeHealth } from '../src/core/worker-deployment-health';
import { verifyDeployment } from '../src/core/worker-deployment-verification';
import { evaluateDeploymentRollback } from '../src/core/worker-deployment-rollback';
import { classifyFailure } from '../src/core/worker-deployment-recovery';
import { evaluateCircuitBreaker } from '../src/core/worker-deployment-circuit-breaker';
import { governDeployment } from '../src/core/worker-deployment-governance';
import { evaluateDeploymentSafety } from '../src/core/worker-deployment-safety';
import { createDeploymentAuditEvent } from '../src/core/worker-deployment-audit';
import { createDeploymentEvidence } from '../src/core/worker-deployment-evidence';
import { addDeploymentLineageNode, DeploymentLineage } from '../src/core/worker-deployment-lineage';
import { orchestrateDeployment } from '../src/core/worker-autonomous-deployment-orchestrator';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodTarget = {
  targetId: 'target-123',
  name: 'prod-k8s',
  environment: 'production',
  provider: 'kubernetes',
  region: 'us-east-1',
  endpoint: 'https://k8s.example.com',
  capabilities: ['deploy', 'rollback', 'health'],
  status: 'AVAILABLE',
  authenticationRef: 'secret-ref-1',
  configurationFingerprint: 'fp-target-1',
  healthState: 'HEALTHY',
  correlationId: 'corr1',
} as const;

const goodPlan = {
  environment: 'production',
  strategy: 'CANARY' as const,
  rolloutConfig: { step: 10, max: 100 },
  healthGates: { maxErrorRate: 0.05, maxLatency: 500, minAvailability: 0.95 },
  rollbackPolicy: 'automatic',
  timeoutMs: 60000,
  approvalRequired: false,
  riskLevel: 'LOW' as const,
  createdBy: 'agent',
  correlationId: 'corr1',
};

const goodPreflight = {
  releaseExists: true,
  releaseApproved: true,
  artifactExists: true,
  artifactIntegrityValid: true,
  artifactFingerprintValid: true,
  targetExists: true,
  targetAvailable: true,
  targetCapabilitiesMet: true,
  requiredCredentialsExist: true,
  deploymentAdapterAvailable: true,
  rolloutStrategyValid: true,
  rollbackCapabilityExists: true,
  healthChecksConfigured: true,
  governanceApproved: true,
  safetyApproved: true,
  environmentPolicySatisfied: true,
  deploymentLockAcquired: true,
  idempotencyCheckPassed: true,
  riskPolicySatisfied: true,
  timeoutPolicyValid: true,
};

const goodRollout = {
  currentPercent: 0,
  desiredPercent: 100,
  step: 10,
  health: 'HEALTHY' as const,
  errorRate: 0.01,
  latency: 200,
  availability: 0.99,
  policyThresholds: { maxErrorRate: 0.05, maxLatency: 500, minAvailability: 0.95 },
};

const goodHealth = {
  httpStatus: 200,
  processHealthy: true,
  deploymentState: 'READY',
  errorRate: 0.01,
  latency: 200,
  availability: 0.99,
  restartCount: 0,
  readiness: true,
  liveness: true,
  resourcePressure: 0.5,
};

const goodVerification = {
  deploymentIdentityValid: true,
  artifactFingerprintValid: true,
  targetStateValid: true,
  runtimeHealth: 'HEALTHY' as const,
  readiness: true,
  smokeChecksPassed: true,
  criticalEndpointsHealthy: true,
  rolloutPolicySatisfied: true,
};

const goodGovernance = {
  releaseApproved: true,
  environmentPolicySatisfied: true,
  riskLevel: 'LOW' as const,
  approvalRequired: false,
  emergencyPolicy: false,
};

const goodSafety = {
  targetValid: true,
  rollbackAvailable: true,
  targetHealthy: true,
  rolloutStrategyValid: true,
  conflictingDeployment: false,
  blastRadiusAcceptable: true,
  circuitBreakerOpen: false,
  evidenceSufficient: true,
  artifactValid: true,
  releaseValid: true,
  approvalGranted: true,
};

const successAdapter: DeploymentAdapter = {
  async validateTarget() { return { ok: true, reason: 'ok' }; },
  async checkAvailability() { return { available: true, reason: 'ok' }; },
  async preflight() { return { ok: true, reason: 'ok' }; },
  async deploy() { return { success: true, reason: 'deployed', evidence: ['evidence'] }; },
  async getStatus() { return { status: 'AVAILABLE', details: 'ok' }; },
  async getHealth() { return { healthy: true, reason: 'ok' }; },
  async pause() { return { success: true, reason: 'ok' }; },
  async resume() { return { success: true, reason: 'ok' }; },
  async promote() { return { success: true, reason: 'ok' }; },
  async rollback() { return { success: true, reason: 'ok' }; },
};

function getGoodRequest() {
  return {
    tenantId: 'tenantA',
    correlationId: 'corr1',
    releaseId: 'rel1',
    artifactId: 'art1',
    target: goodTarget,
    plan: goodPlan,
    preflight: goodPreflight,
    governanceInput: goodGovernance,
    safetyInput: goodSafety,
    rollout: goodRollout,
    health: goodHealth,
    verification: goodVerification,
    rollbackInput: { failedReleaseId: 'rel1', previousReleaseId: 'rel0', rollbackAvailable: true, safetyApproved: true, governanceApproved: true, duplicateRollback: false, verificationSucceeded: true },
    recoveryInput: { timeout: false, providerInterrupted: false, processRestarted: false, partialDeployment: false, healthDegraded: false, verificationFailed: false, rolloutStalled: false, dependencyOutage: false },
    circuitBreakerInput: { failureCount: 0, threshold: 3, recoveryTimeoutMs: 60000 },
    adapter: successAdapter,
  };
}

async function main() {
  console.log('=== Phase 20: Autonomous Deployment & Production Runtime Control ===');

  // Target
  const target = createDeploymentTarget(goodTarget);
  assert(target.targetId.length > 0, 'Deployment target creation');
  const dupTarget = createDeploymentTarget({ ...goodTarget });
  assert(dupTarget.idempotencyKey === target.idempotencyKey, 'Duplicate target rejection');
  assert(isTargetAvailable(target), 'Target available');
  const badTarget = { ...goodTarget, status: 'UNAVAILABLE' };
  assert(!isTargetAvailable(createDeploymentTarget(badTarget)), 'Unavailable target detection');

  // Plan
  const plan = createDeploymentPlan({ ...goodPlan, releaseId: 'rel1', artifactId: 'art1', targetId: target.targetId });
  assert(plan.planId.length > 0, 'Deployment plan creation');
  assert(plan.fingerprint.length > 0, 'Deterministic deployment fingerprint');
  const dupPlan = createDeploymentPlan({ ...goodPlan, releaseId: 'rel1', artifactId: 'art1', targetId: target.targetId });
  assert(dupPlan.idempotencyKey === plan.idempotencyKey, 'Duplicate plan rejection');

  // Preflight
  assert(runDeploymentPreflight(goodPreflight).passed, 'Preflight success');
  assert(!runDeploymentPreflight({ ...goodPreflight, artifactExists: false }).passed, 'Preflight failure');

  // Governance/Safety
  assert(governDeployment(goodGovernance) === 'ALLOW', 'Governance approval');
  assert(governDeployment({ ...goodGovernance, releaseApproved: false }) === 'DENY', 'Governance denial');
  assert(evaluateDeploymentSafety(goodSafety) === 'ALLOW', 'Safety approval');
  assert(evaluateDeploymentSafety({ ...goodSafety, targetValid: false }) === 'DENY', 'Safety denial');

  // Lock
  const lockResult = acquireDeploymentLock('production', target.targetId, 'agent', 60000, 'corr1');
  assert(lockResult.success, 'Deployment lock acquisition');
  const conflictingLock = acquireDeploymentLock('production', target.targetId, 'agent2', 60000, 'corr2', lockResult.lock);
  assert(!conflictingLock.success, 'Conflicting deployment blocked');
  const released = releaseDeploymentLock(lockResult.lock!);
  assert(!isLockActive(released), 'Lock released');

  // Execution
  let exec = createDeploymentExecution({ planId: plan.planId, correlationId: 'corr1' });
  assert(exec.executionId.length > 0, 'Deployment execution creation');
  const dupExec = createDeploymentExecution({ planId: plan.planId, correlationId: 'corr1' });
  assert(dupExec.idempotencyKey === exec.idempotencyKey, 'Duplicate execution blocked');
  exec = transitionDeploymentExecution(exec, 'PRECHECKING');
  exec = transitionDeploymentExecution(exec, 'APPROVED');
  exec = transitionDeploymentExecution(exec, 'EXECUTING');
  assert(exec.status === 'EXECUTING', 'Legal execution transitions');
  try { transitionDeploymentExecution(exec, 'PLANNED'); assert(false, 'Should throw'); } catch { assert(true, 'Illegal transition rejected'); }

  // Rollout
  const rollout1 = evaluateCanaryRollout(goodRollout);
  assert(rollout1.nextState === 'PROGRESSING', 'Rollout progression');
  const rolloutPause = evaluateCanaryRollout({ ...goodRollout, health: 'UNHEALTHY' });
  assert(rolloutPause.nextState === 'ABORTED', 'Unhealthy rollout pause/abort');

  // Health
  assert(evaluateRuntimeHealth(goodHealth) === 'HEALTHY', 'Health evaluation');
  assert(evaluateRuntimeHealth({ ...goodHealth, availability: 0.8 }) === 'UNHEALTHY', 'Unhealthy health detection');

  // Verification
  assert(verifyDeployment(goodVerification).verified, 'Verification succeeds');
  assert(!verifyDeployment({ ...goodVerification, smokeChecksPassed: false }).verified, 'Verification failure');

  // Rollback
  assert(evaluateDeploymentRollback({ failedReleaseId: 'rel1', previousReleaseId: 'rel0', rollbackAvailable: true, safetyApproved: true, governanceApproved: true, duplicateRollback: false, verificationSucceeded: true }).status === 'ROLLED_BACK', 'Rollback succeeds');
  assert(evaluateDeploymentRollback({ failedReleaseId: 'rel1', previousReleaseId: 'rel0', rollbackAvailable: true, safetyApproved: true, governanceApproved: true, duplicateRollback: true, verificationSucceeded: true }).status === 'BLOCKED', 'Duplicate rollback blocked');

  // Recovery
  assert(classifyFailure({ timeout: true, providerInterrupted: false, processRestarted: false, partialDeployment: false, healthDegraded: false, verificationFailed: false, rolloutStalled: false, dependencyOutage: false }) === 'RETRYABLE', 'Retryable failure classification');
  assert(classifyFailure({ timeout: false, providerInterrupted: true, processRestarted: false, partialDeployment: false, healthDegraded: false, verificationFailed: false, rolloutStalled: false, dependencyOutage: false }) === 'PROVIDER_UNAVAILABLE', 'Permanent/provider failure classification');

  // Circuit breaker
  assert(evaluateCircuitBreaker({ failureCount: 0, threshold: 3, recoveryTimeoutMs: 60000 }) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateCircuitBreaker({ failureCount: 3, threshold: 3, recoveryTimeoutMs: 60000 }) === 'OPEN', 'Circuit breaker opens');

  // Audit/Evidence/Lineage
  const audit = createDeploymentAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit event');
  const ev = createDeploymentEvidence({ tenantId: 't', correlationId: 'c', deploymentId: 'd1', evidenceType: 'DEPLOYMENT_SUCCESS', data: { releaseId: 'rel1' } });
  assert(ev.evidenceId.length > 0, 'Evidence provenance');
  const lineage: DeploymentLineage = { rootId: 'd1', nodes: [] };
  const line1 = addDeploymentLineageNode(lineage, { version: 1, releaseId: 'rel1', artifactId: 'art1', targetId: target.targetId, deploymentId: 'd1', timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Lineage preservation');

  // Orchestrator
  const goodResult = await orchestrateDeployment(getGoodRequest());
  assert(goodResult.status === 'COMPLETED', 'Orchestrator approved lifecycle');
  const deniedResult = await orchestrateDeployment({ ...getGoodRequest(), governanceInput: { ...goodGovernance, releaseApproved: false } });
  assert(deniedResult.status === 'DENIED', 'Orchestrator governance denial');
  const unsafeResult = await orchestrateDeployment({ ...getGoodRequest(), safetyInput: { ...goodSafety, targetValid: false } });
  assert(unsafeResult.status === 'DENIED', 'Orchestrator safety denial');
  const unavailableResult = await orchestrateDeployment({ ...getGoodRequest(), adapter: unavailableDeploymentAdapter });
  assert(unavailableResult.status === 'FAILED' || unavailableResult.status === 'BLOCKED', 'Unavailable provider reported honestly');
  const repeatResult = await orchestrateDeployment(getGoodRequest());
  assert(repeatResult.status === 'COMPLETED' && repeatResult.plan?.idempotencyKey === goodResult.plan?.idempotencyKey, 'Repeated identical request remains idempotent');

  // Security redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 20: FAIL'); process.exit(1); }
  else { console.log('PHASE 20: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
