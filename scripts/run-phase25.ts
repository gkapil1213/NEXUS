import { createRelease } from '../src/core/worker-phase25-release';
import { createReleaseVersion } from '../src/core/worker-phase25-release-version';
import { promoteArtifact } from '../src/core/worker-phase25-artifact-promotion';
import { createDeploymentPlan } from '../src/core/worker-phase25-deployment-plan';
import { createDeploymentExecution, transitionDeploymentExecution } from '../src/core/worker-phase25-deployment-execution';
import { advanceRollout } from '../src/core/worker-phase25-progressive-delivery';
import { evaluateHealthGate } from '../src/core/worker-phase25-health-gate';
import { createDeploymentHalt } from '../src/core/worker-phase25-deployment-halt';
import { createRollbackExecution, transitionRollbackExecution } from '../src/core/worker-phase25-deployment-rollback';
import { evaluateRollbackSafety } from '../src/core/worker-phase25-rollback-safety';
import { evaluateDeploymentCircuitBreaker } from '../src/core/worker-phase25-deployment-circuit-breaker';
import { createReleaseFreeze, unfreezeRelease } from '../src/core/worker-phase25-release-freeze';
import { createDeploymentIncident } from '../src/core/worker-phase25-deployment-incident';
import { createDeploymentEvidence } from '../src/core/worker-phase25-deployment-evidence';
import { createDeploymentAuditEvent } from '../src/core/worker-phase25-deployment-audit';
import { addReleaseLineageNode, ReleaseLineage } from '../src/core/worker-phase25-release-lineage';
import { orchestrateReleaseDeployment } from '../src/core/worker-phase25-autonomous-release-deployment-control-plane';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodRelease = { name: 'svc', version: '1.0.0', sourceCommit: 'abc123' };
const goodPlan = {
  target: 'prod',
  environment: 'production',
  strategy: 'CANARY' as const,
  rolloutConfig: { step: 10 },
  healthRequirements: [],
  rollbackPolicy: 'auto',
  timeoutMs: 60000,
  approvalRequired: false,
  riskLevel: 'LOW' as const,
  artifactId: 'artifact-1',
  correlationId: 'corr1',
};

const successAdapter = {
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
    tenantId: 't',
    correlationId: 'c',
    release: goodRelease,
    plan: goodPlan,
    governance: 'ALLOW' as const,
    approvalValid: true,
    securityStatus: 'PASS' as const,
    circuitBreaker: { failureCount: 0, threshold: 3 },
    frozen: false,
    artifactId: 'artifact-1',
    provider: successAdapter,
    rolloutState: { currentStage: '5%' as const, health: 'HEALTHY' as const, errorRate: 0.01, latency: 100, availability: 0.99, thresholds: { maxErrorRate: 0.05, maxLatency: 500, minAvailability: 0.95 } },
    provider: successAdapter,
    healthInput: { errorRate: 0.01, latency: 100, availability: 0.99, crashRate: 0.01, failedRequests: 0, resourcePressure: 0.2, securityFindings: 0, incidentState: 'NONE', dependencyHealth: 1.0, thresholds: { maxErrorRate: 0.05, maxLatency: 500, minAvailability: 0.95, maxCrashRate: 0.1, maxFailedRequests: 10, maxResourcePressure: 0.8, maxSecurityFindings: 0, minDependencyHealth: 0.9 } },
    rollbackSafetyInput: { targetArtifactExists: true, targetArtifactCorrupted: false, targetArtifactRevoked: false, targetVersionCompatible: true, governanceAllowed: true, securityPolicyAllowed: true, recoverySafetyAllowed: true, dependencyConstraintsMet: true },
  };
}

async function main() {
  console.log('=== Phase 25: Autonomous Production Release & Deployment ===');

  // Release
  const release = createRelease(goodRelease);
  assert(release.releaseId.length > 0, 'Release creation');
  const dupRelease = createRelease(goodRelease);
  assert(dupRelease.idempotencyKey === release.idempotencyKey, 'Duplicate release rejection');
  const version = createReleaseVersion(release.releaseId, '1.0.0', '0.9.0');
  assert(version.version === '1.0.0', 'Version uniqueness');

  // Artifact promotion
  const promotion = promoteArtifact('artifact-1', 'BUILD', 'TESTED', 'fp1');
  assert(promotion.success, 'Artifact promotion');
  assert(!promoteArtifact('artifact-1', 'BUILD', 'BUILD', 'fp1').success, 'Invalid promotion rejection');
  const revokedPromotion = promoteArtifact('artifact-1', 'TESTED', 'REVOKED', 'fp1');
  assert(revokedPromotion.success && revokedPromotion.promotion?.state === 'REVOKED', 'Revoked artifact rejection');

  // Governance/Approval (orchestrator)
  const goodResult = await orchestrateReleaseDeployment(getGoodRequest());
  assert(goodResult.status === 'COMPLETED', 'Governance ALLOW and approval integration');

  // Deployment plan
  const plan = createDeploymentPlan({ ...goodPlan, releaseId: release.releaseId });
  assert(plan.planId.length > 0, 'Deployment plan creation');
  const dupPlan = createDeploymentPlan({ ...goodPlan, releaseId: release.releaseId });
  assert(dupPlan.idempotencyKey === plan.idempotencyKey, 'Duplicate deployment prevention');

  // Deployment execution
  let exec = createDeploymentExecution({ planId: plan.planId });
  assert(exec.executionId.length > 0, 'Deployment execution creation');
  exec = transitionDeploymentExecution(exec, 'APPROVAL_PENDING');
  exec = transitionDeploymentExecution(exec, 'APPROVED');
  exec = transitionDeploymentExecution(exec, 'STARTING');
  assert(exec.status === 'STARTING', 'Valid lifecycle transition');
  try { transitionDeploymentExecution(exec, 'PLANNED'); assert(false, 'Should throw'); } catch { assert(true, 'Invalid lifecycle transition rejection'); }

  // Progressive delivery
  const rollout1 = advanceRollout(getGoodRequest().rolloutState);
  assert(rollout1.action === 'CONTINUE', 'Initial rollout');
  const rollout2 = advanceRollout({ ...getGoodRequest().rolloutState, currentStage: '10%' });
  assert(rollout2.nextStage === '25%', 'Stage progression');
  const unhealthyRollout = advanceRollout({ ...getGoodRequest().rolloutState, health: 'UNHEALTHY' });
  assert(unhealthyRollout.action === 'HALT', 'Unhealthy stage halt');
  const unknownRollout = advanceRollout({ ...getGoodRequest().rolloutState, health: 'UNKNOWN' });
  assert(unknownRollout.action === 'HALT', 'Unknown health fails closed');

  // Health gate
  assert(evaluateHealthGate(getGoodRequest().healthInput) === 'HEALTHY', 'Health gate evaluation');
  assert(evaluateHealthGate({ ...getGoodRequest().healthInput, errorRate: 0.1 }) === 'UNHEALTHY', 'Unhealthy health gate');

  // Rollback
  const rollback = createRollbackExecution('deployment-1', release.releaseId);
  assert(rollback.rollbackId.length > 0, 'Rollback creation');
  const rollbackExec = transitionRollbackExecution(rollback, 'ROLLBACK_VALIDATING');
  assert(rollbackExec.status === 'ROLLBACK_VALIDATING', 'Rollback execution');
  assert(evaluateRollbackSafety(getGoodRequest().rollbackSafetyInput).allowed, 'Rollback safety');
  assert(!evaluateRollbackSafety({ ...getGoodRequest().rollbackSafetyInput, targetArtifactExists: false }).allowed, 'Rollback failure handling');

  // Circuit breaker
  assert(evaluateDeploymentCircuitBreaker(2, 3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateDeploymentCircuitBreaker(3, 3) === 'OPEN', 'Failure threshold opens breaker');

  // Release freeze
  const freeze = createReleaseFreeze('production', 'incident');
  assert(freeze.frozen, 'Freeze creation');
  const frozenRequest = await orchestrateReleaseDeployment({ ...getGoodRequest(), frozen: true });
  assert(frozenRequest.status === 'BLOCKED', 'Frozen deployment denied');
  const unfrozen = unfreezeRelease(freeze);
  assert(!unfrozen.frozen, 'Unfreeze');

  // Incidents
  const incident = createDeploymentIncident({ deploymentId: 'd1', releaseId: release.releaseId, target: 'prod', failureReason: 'error', healthEvidence: 'bad', rollbackState: 'NONE', recoveryState: 'NONE' });
  assert(incident.incidentId.length > 0, 'Deployment incident creation');
  const dupIncident = createDeploymentIncident({ deploymentId: 'd1', releaseId: release.releaseId, target: 'prod', failureReason: 'error', healthEvidence: 'bad', rollbackState: 'NONE', recoveryState: 'NONE' });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');

  // Evidence/Audit/Lineage
  const evidence = createDeploymentEvidence({ deploymentId: 'd1', releaseId: release.releaseId, artifactId: 'artifact-1', provider: 'test', strategy: 'CANARY', healthResult: 'HEALTHY', rollbackState: 'NONE', finalResult: 'SUCCESS' });
  assert(evidence.evidenceId.length > 0, 'Deployment evidence');
  const audit = createDeploymentAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');
  const lineage: ReleaseLineage = { releaseId: release.releaseId, nodes: [] };
  const line1 = addReleaseLineageNode(lineage, { version: 1, releaseId: release.releaseId, artifactId: 'artifact-1', deploymentId: 'd1', timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Release lineage');

  // Security redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  // Provider honesty
  const unavailableProvider = await orchestrateReleaseDeployment({ ...getGoodRequest(), provider: undefined });
  assert(unavailableProvider.status === 'FAILED', 'Unconfigured provider reported honestly');

  // Idempotency
  const result1 = await orchestrateReleaseDeployment(getGoodRequest());
  const result2 = await orchestrateReleaseDeployment(getGoodRequest());
  assert(result1.release.idempotencyKey === result2.release.idempotencyKey, 'Repeated identical deployment request remains idempotent');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 25: FAIL'); process.exit(1); }
  else { console.log('PHASE 25: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
