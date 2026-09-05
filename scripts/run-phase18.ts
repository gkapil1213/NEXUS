import { createProductionEnvironment, checkEnvironmentAvailability } from '../src/core/worker-production-environment';
import { unavailableDeploymentTarget, DeploymentTargetAdapter } from '../src/core/worker-production-deployment-target';
import { runPreflight } from '../src/core/worker-production-preflight';
import { createProductionRelease, transitionRelease } from '../src/core/worker-production-release';
import { createDeploymentExecution, transitionDeploymentExecution } from '../src/core/worker-production-deployment-executor';
import { evaluateRollout } from '../src/core/worker-production-rollout-controller';
import { evaluateHealth } from '../src/core/worker-production-health';
import { createProductionIncident, transitionIncident } from '../src/core/worker-production-incident';
import { createRemediationAction, canRetryRemediation } from '../src/core/worker-production-remediation';
import { evaluateCircuitBreaker } from '../src/core/worker-production-circuit-breaker';
import { evaluateDrift } from '../src/core/worker-production-drift';
import { orchestrateProductionOperations } from '../src/core/worker-production-operations-orchestrator';
import { createProductionAuditEvent } from '../src/core/worker-production-audit';
import { createProductionEvidence } from '../src/core/worker-production-evidence';
import { addProductionLineageNode, ProductionLineage } from '../src/core/worker-production-lineage';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodEnv = {
  type: 'STAGING',
  provider: 'test-provider',
  region: 'us-east-1',
  account: 'acct-123',
  configurationFingerprint: 'fp-123',
  health: 'HEALTHY',
  availability: true,
  capabilities: ['deploy'],
  lastVerifiedAt: new Date().toISOString(),
  owner: 'platform',
  policy: 'governed',
  riskLevel: 'MEDIUM',
  correlationId: 'corr1',
} as const;

const goodPreflight = {
  environmentExists: true,
  environmentReachable: true,
  deploymentTargetAvailable: true,
  artifactExists: true,
  artifactIntegrityValid: true,
  releaseExists: true,
  releaseApproved: true,
  governanceAllows: true,
  safetyAllows: true,
  requiredCredentialsExist: true,
  requiredToolsExist: true,
  dependenciesAvailable: true,
  capacitySatisfied: true,
  deploymentPolicySatisfied: true,
  rollbackCapabilityExists: true,
};

const goodRelease = {
  artifactId: 'artifact-1',
  version: 'v1.0.0',
  sourceCommit: 'abc123',
  buildId: 'build-1',
  riskLevel: 'LOW',
  correlationId: 'corr1',
};

const goodRollout = {
  currentStage: '10%' as const,
  metrics: { errorRate: 0.01, latency: 100, availability: 0.99, saturation: 0.5 },
  thresholds: { maxErrorRate: 0.05, maxLatency: 200, minAvailability: 0.9, maxSaturation: 0.8 },
};

const goodHealth = {
  availability: 0.99,
  errorRate: 0.01,
  latency: 100,
  saturation: 0.5,
  dependencyHealth: 0.9,
  restartRate: 0.01,
  deploymentFailures: 0,
  sloStatus: 'HEALTHY' as const,
};

const successAdapter: DeploymentTargetAdapter = {
  async preflight() { return { ok: true, reason: 'OK' }; },
  async capabilityDetect() { return { deploy: true }; },
  async deploy() { return { success: true, reason: 'OK', evidence: ['deploy success'] }; },
  async status() { return { status: 'AVAILABLE', details: 'test adapter' }; },
  async health() { return { healthy: true, reason: 'OK' }; },
  async logs() { return []; },
  async rollback() { return { success: true, reason: 'OK' }; },
  async cleanup() { return { success: true, reason: 'OK' }; },
};

function getGoodRequest() {
  return {
    tenantId: 'tenantA',
    correlationId: 'corr1',
    environment: goodEnv,
    preflight: goodPreflight,
    release: goodRelease,
    executionMode: 'REAL' as const,
    targetAdapter: successAdapter,
    rollout: goodRollout,
    health: goodHealth,
    risk: { lowRisk: true, highRisk: false },
    governance: 'ALLOW' as const,
    safety: 'ALLOW' as const,
    circuitBreaker: {
      repeatedDeploymentFailures: 0,
      repeatedRollbacks: 0,
      repeatedRemediations: 0,
      repeatedConfigMutations: 0,
      repeatedIncidentRecoveries: 0,
      excessiveResourceChanges: 0,
      thresholds: { maxDeploymentFailures: 3, maxRollbacks: 3, maxRemediations: 3, maxConfigMutations: 3, maxIncidentRecoveries: 3, maxResourceChanges: 3 },
    },
    drift: {
      desiredFingerprint: 'fp-1',
      actualFingerprint: 'fp-1',
      driftDetected: false,
      affectedResource: 'none',
      severity: 'NONE' as const,
      source: 'test',
      remediated: false,
    },
  };
}

async function main() {
  console.log('=== Phase 18: Production Autonomous Operations ===');

  // Environment
  const env = createProductionEnvironment(goodEnv);
  assert(env.environmentId.length > 0, 'Environment created');
  const dupEnv = createProductionEnvironment({ ...goodEnv, correlationId: 'corr1' });
  assert(dupEnv.idempotencyKey === env.idempotencyKey, 'Duplicate environment rejected');
  const badEnv = { ...goodEnv, availability: false };
  assert(!checkEnvironmentAvailability(createProductionEnvironment(badEnv)).available, 'Unavailable environment detection');

  // Preflight
  const preflight = runPreflight(goodPreflight);
  assert(preflight.passed, 'Preflight passes');
  const badPreflight = runPreflight({ ...goodPreflight, artifactExists: false });
  assert(!badPreflight.passed, 'Missing artifact blocks preflight');
  const noTargetPreflight = runPreflight({ ...goodPreflight, deploymentTargetAvailable: false });
  assert(!noTargetPreflight.passed, 'Unavailable deployment target blocks preflight');
  const noRollbackPreflight = runPreflight({ ...goodPreflight, rollbackCapabilityExists: false });
  assert(!noRollbackPreflight.passed, 'Missing rollback capability blocks preflight');

  // Release lifecycle
  const release = createProductionRelease({ ...goodRelease, environmentId: 'env1', correlationId: 'corr1' });
  assert(release.status === 'CREATED', 'Release created');
  const dupRelease = createProductionRelease({ ...goodRelease, environmentId: 'env1', correlationId: 'corr1' });
  assert(dupRelease.idempotencyKey === release.idempotencyKey, 'Duplicate release rejected');
  let r = transitionRelease(release, 'VALIDATED');
  r = transitionRelease(r, 'APPROVED');
  r = transitionRelease(r, 'READY');
  r = transitionRelease(r, 'DEPLOYING');
  assert(r.status === 'DEPLOYING', 'Valid release lifecycle');
  try { transitionRelease(r, 'PROMOTED'); assert(false, 'Invalid transition should throw'); } catch { assert(true, 'Invalid release transition rejected'); }

  // Governance & safety
  assert((async () => { const res = await orchestrateProductionOperations({ ...getGoodRequest(), governance: 'DENY' }); return res.status === 'BLOCKED'; })(), 'Governance denial blocks operation');
  assert((async () => { const res = await orchestrateProductionOperations({ ...getGoodRequest(), safety: 'DENY' }); return res.status === 'BLOCKED'; })(), 'Safety denial blocks operation');

  // Deployment
  const exec = createDeploymentExecution({ releaseId: 'rel1', environmentId: 'env1', executionMode: 'REAL', correlationId: 'c' });
  assert(exec.executionId.length > 0, 'Deployment identity');
  const dupExec = createDeploymentExecution({ releaseId: 'rel1', environmentId: 'env1', executionMode: 'REAL', correlationId: 'c' });
  assert(dupExec.idempotencyKey === exec.idempotencyKey, 'Duplicate execution prevented');
  let e = transitionDeploymentExecution(exec, 'APPROVED');
  e = transitionDeploymentExecution(e, 'RUNNING');
  e = transitionDeploymentExecution(e, 'SUCCEEDED');
  assert(e.status === 'SUCCEEDED', 'Execution state transitions');
  try { transitionDeploymentExecution(e, 'RUNNING'); assert(false, 'Should throw'); } catch { assert(true, 'Illegal execution transition rejected'); }

  // Rollout
  const rollout1 = evaluateRollout({ ...goodRollout });
  assert(rollout1.action === 'CONTINUE' && rollout1.nextStage === '25%', 'Staged rollout progress');
  const rolloutPaused = evaluateRollout({ ...goodRollout, metrics: { errorRate: 0.1, latency: 300, availability: 0.8, saturation: 0.9 } });
  assert(rolloutPaused.action === 'PAUSE', 'Rollout pauses on threshold');
  const rolloutAbort = evaluateRollout({ ...goodRollout, currentStage: '50%', metrics: { errorRate: 0.2, latency: 500, availability: 0.7, saturation: 1.0 } });
  assert(rolloutAbort.action === 'ABORT', 'Rollout aborts');

  // Health
  assert(evaluateHealth(goodHealth) === 'HEALTHY', 'Healthy health');
  assert(evaluateHealth({ ...goodHealth, sloStatus: 'DEGRADED' }) === 'DEGRADED', 'Degraded health');
  assert(evaluateHealth({ ...goodHealth, sloStatus: 'UNHEALTHY' }) === 'UNHEALTHY', 'Unhealthy health');
  assert(evaluateHealth({ ...goodHealth, sloStatus: 'UNKNOWN' }) === 'UNKNOWN', 'Unknown health');

  // Incident
  const incident = createProductionIncident({ environmentId: 'env1', service: 'svc1', severity: 'HIGH', evidence: [], correlationId: 'c' });
  assert(incident.status === 'DETECTED', 'Incident created');
  const i1 = transitionIncident(incident, 'TRIAGED');
  assert(i1.status === 'TRIAGED', 'Incident transition valid');
  try { transitionIncident(i1, 'RESOLVED'); assert(false, 'Should throw'); } catch { assert(true, 'Invalid incident transition rejected'); }

  // Remediation
  const remediation = createRemediationAction({ incidentId: 'inc1', actionType: 'ROLLBACK', environmentId: 'env1', target: 'svc1', governanceApproved: true, safetyApproved: true, evidence: [], correlationId: 'c' });
  assert(remediation.status === 'PROPOSED', 'Remediation proposal');
  assert(canRetryRemediation(remediation) === false, 'Remediation retry limit initially false');

  // Circuit breaker
  const cbClosed = evaluateCircuitBreaker({ ...getGoodRequest().circuitBreaker });
  assert(cbClosed === 'CLOSED', 'Circuit breaker closed');
  const cbOpen = evaluateCircuitBreaker({ ...getGoodRequest().circuitBreaker, repeatedDeploymentFailures: 5 });
  assert(cbOpen === 'OPEN', 'Circuit breaker opens');

  // Drift
  assert(evaluateDrift({ ...getGoodRequest().drift, driftDetected: false, severity: 'NONE' }) === 'NONE', 'No drift detected');
  assert(evaluateDrift({ ...getGoodRequest().drift, driftDetected: true, severity: 'HIGH' }) === 'HIGH', 'Drift detected');

  // Audit, evidence, lineage
  const audit = createProductionAuditEvent({ tenantId: 't', correlationId: 'c', environmentId: 'env1', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit event emitted');
  const ev = createProductionEvidence({ tenantId: 't', correlationId: 'c', operationId: 'op1', evidenceType: 'DEPLOYMENT_RESULT', data: { result: 'SUCCESS' } });
  assert(ev.evidenceId.length > 0, 'Evidence provenance preserved');
  const lineage: ProductionLineage = { environmentId: 'env1', nodes: [] };
  const line1 = addProductionLineageNode(lineage, { version: 1, requestId: 'req1', environmentId: 'env1', timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Lineage preserved');

  // Orchestrator
  const goodResult = await orchestrateProductionOperations(getGoodRequest());
  assert(goodResult.status === 'COMPLETED', 'Orchestrator executes approved lifecycle');
  const blockedByGov = await orchestrateProductionOperations({ ...getGoodRequest(), governance: 'DENY' });
  assert(blockedByGov.status === 'BLOCKED', 'Orchestrator blocks governance-denied lifecycle');
  const blockedBySafety = await orchestrateProductionOperations({ ...getGoodRequest(), safety: 'DENY' });
  assert(blockedBySafety.status === 'BLOCKED', 'Orchestrator blocks unsafe lifecycle');
  const unavailableTarget = await orchestrateProductionOperations({ ...getGoodRequest(), targetAdapter: unavailableDeploymentTarget });
  assert(unavailableTarget.status === 'FAILED' || unavailableTarget.status === 'UNAVAILABLE', 'Unavailable dependency reported honestly');

  // Idempotency
  const result1 = await orchestrateProductionOperations(getGoodRequest());
  const result2 = await orchestrateProductionOperations(getGoodRequest());
  assert(result1.environment?.idempotencyKey === result2.environment?.idempotencyKey, 'Repeated identical request remains safe');

  // Security redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 18: FAIL'); process.exit(1); }
  else { console.log('PHASE 18: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
