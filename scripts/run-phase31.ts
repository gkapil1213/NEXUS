import { createPlatformEnvironment } from '../src/core/worker-phase31-environment';
import { discoverEnvironments } from '../src/core/worker-phase31-environment-discovery';
import { createFleet } from '../src/core/worker-phase31-fleet';
import { addFleetMember } from '../src/core/worker-phase31-fleet-membership';
import { evaluateEnvironmentHealth } from '../src/core/worker-phase31-environment-health';
import { evaluateFleetHealth } from '../src/core/worker-phase31-fleet-health';
import { detectConfigDrift } from '../src/core/worker-phase31-configuration-drift';
import { detectVersionDrift } from '../src/core/worker-phase31-version-drift';
import { validateGraph } from '../src/core/worker-phase31-dependency-graph';
import { assessFleetRisk } from '../src/core/worker-phase31-fleet-risk';
import { calculateFleetBlastRadius } from '../src/core/worker-phase31-fleet-blast-radius';
import { correlateFleetChange } from '../src/core/worker-phase31-fleet-change-correlation';
import { createRolloutWave } from '../src/core/worker-phase31-rollout-wave';
import { createFleetRolloutPlan } from '../src/core/worker-phase31-fleet-rollout-plan';
import { governFleetAction } from '../src/core/worker-phase31-fleet-governance';
import { evaluateFleetSafety } from '../src/core/worker-phase31-fleet-safety';
import { createFleetExecution, transitionFleetExecution } from '../src/core/worker-phase31-fleet-execution';
import { evaluateHealthGate } from '../src/core/worker-phase31-fleet-health-gate';
import { createFleetHalt } from '../src/core/worker-phase31-fleet-halt';
import { createFleetRollback } from '../src/core/worker-phase31-fleet-rollback';
import { createFleetRemediationPlan } from '../src/core/worker-phase31-fleet-remediation-plan';
import { createFleetRemediationExecution, transitionFleetRemediationExecution } from '../src/core/worker-phase31-fleet-remediation-execution';
import { evaluateFleetRemediationSafety } from '../src/core/worker-phase31-fleet-remediation-safety';
import { createFleetRemediationRollback } from '../src/core/worker-phase31-fleet-remediation-rollback';
import { evaluateFleetCircuitBreaker } from '../src/core/worker-phase31-fleet-circuit-breaker';
import { createFleetIncident } from '../src/core/worker-phase31-fleet-incident';
import { determineEscalation } from '../src/core/worker-phase31-fleet-escalation';
import { createFleetEvidence } from '../src/core/worker-phase31-fleet-evidence';
import { createFleetAuditEvent } from '../src/core/worker-phase31-fleet-audit';
import { addFleetLineageNode, FleetLineage } from '../src/core/worker-phase31-fleet-lineage';
import { createFleetLearningRecord } from '../src/core/worker-phase31-fleet-learning';
import { orchestrateFleetOperations } from '../src/core/worker-phase31-autonomous-platform-fleet-control-plane';
import { unconfiguredFleetProvider } from '../src/core/worker-phase31-provider';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodEnv = {
  name: 'prod', type: 'PRODUCTION' as const, provider: 'aws', region: 'us-east-1', account: '123', cluster: 'c1',
  lifecycleState: 'ACTIVE', healthState: 'HEALTHY', criticality: 'HIGH' as const, protectionLevel: 'high',
  production: true, drRelationship: 'dr', configurationFingerprint: 'cfg1', versionFingerprint: 'v1', metadata: {}, correlationId: 'c'
};
const goodFleet = {
  name: 'fleet1', fleetType: 'application', environmentScope: ['prod'], memberResources: ['svc1'], criticality: 'HIGH',
  ownership: 'team', health: 'HEALTHY', desiredState: 'desired', observedState: 'observed', version: 'v1',
  configurationFingerprint: 'cfg1', protectionState: 'standard', operationalPolicy: 'policy', metadata: {}, correlationId: 'c'
};
const goodHealth = { applicationHealth: 'HEALTHY', infrastructureHealth: 'HEALTHY', databaseHealth: 'HEALTHY', securityHealth: 'HEALTHY', dependencyHealth: 'HEALTHY', deploymentHealth: 'HEALTHY', incidentSeverity: 'NONE', capacity: 'HEALTHY', costRisk: 'LOW' };
const goodRiskInput = { criticality: 'HIGH', environment: 'prod', dependencyCount: 1, securityPosture: 'HEALTHY', configDrift: 'NO_DRIFT', versionDrift: 'NO_DRIFT', health: 'HEALTHY', incidentHistory: 0, blastRadius: 'LOW' as const, rollbackCapability: true };
const goodGovernance = { environment: 'prod', fleetCriticality: 'HIGH', production: true, action: 'rollout', blastRadius: 'LOW' as const, risk: 'LOW' as const, protectedResource: false, changePolicy: 'ALLOW', approvalRequired: false };
const goodSafety = { destructiveAction: false, uncontrolledProduction: false, crossEnvironmentContamination: false, unsafeFleetWideChange: false, unsafeRollback: false, unknownDependency: false, providerUnavailable: false };
const goodProvider = { status: 'CONFIGURED' as const, capabilities: ['deploy'], async executeAction() { return { success: true, reason: 'ok' }; } };

function getGoodRequest() {
  return {
    tenantId: 't', correlationId: 'c',
    environment: goodEnv,
    fleet: goodFleet,
    environmentHealth: goodHealth,
    fleetHealth: goodHealth,
    configDesired: 'cfg1', configObserved: 'cfg1',
    versionDesired: 'v1', versionObserved: ['v1'],
    riskInput: goodRiskInput,
    blastRadius: [1, 0, 0, 0],
    governanceInput: goodGovernance,
    safetyInput: goodSafety,
    circuitBreaker: { failureCount: 0, threshold: 3 },
    healthGateInput: ['HEALTHY', 0.01, 100, 'HEALTHY', 0, 0, 'HEALTHY', 'HEALTHY', 'HEALTHY', 'NO_DRIFT'],
    provider: goodProvider,
  };
}

async function main() {
  console.log('=== Phase 31: Autonomous Multi-Environment Platform Operations & Fleet Orchestration ===');

  // Environment
  const env = createPlatformEnvironment(goodEnv);
  assert(env.environmentId.length > 0, 'Environment creation');
  const dupEnv = createPlatformEnvironment(goodEnv);
  assert(dupEnv.idempotencyKey === env.idempotencyKey, 'Duplicate environment prevention');
  const discovery = discoverEnvironments('UNCONFIGURED', []);
  assert(discovery.providerStatus === 'UNCONFIGURED', 'Unknown provider handling');
  const discovery2 = discoverEnvironments('CONFIGURED', [goodEnv]);
  assert(discovery2.environments.length === 1, 'Environment discovery');
  assert(evaluateEnvironmentHealth(goodHealth) === 'HEALTHY', 'Environment health');
  assert(evaluateEnvironmentHealth({ ...goodHealth, applicationHealth: 'UNKNOWN' }) === 'UNKNOWN', 'Unknown environment health');

  // Fleet
  const fleet = createFleet(goodFleet);
  assert(fleet.fleetId.length > 0, 'Fleet creation');
  const dupFleet = createFleet(goodFleet);
  assert(dupFleet.idempotencyKey === fleet.idempotencyKey, 'Duplicate fleet prevention');
  const membership = addFleetMember(fleet.fleetId, 'svc1', 'service');
  assert(membership.membershipId.length > 0, 'Fleet membership');
  const dupMembership = addFleetMember(fleet.fleetId, 'svc1', 'service');
  assert(dupMembership.idempotencyKey === membership.idempotencyKey, 'Duplicate membership prevention');

  // Dependency graph
  const graph = { nodes: ['a', 'b'], edges: { a: ['b'] } };
  assert(validateGraph(graph).valid, 'Dependency graph validation');
  assert(!validateGraph({ nodes: ['a'], edges: { a: ['missing'] } }).valid, 'Dependency validation');

  // Drift
  assert(detectConfigDrift('cfg1', 'cfg1') === 'NO_DRIFT', 'Configuration fingerprint');
  assert(detectConfigDrift('cfg1', 'cfg2') === 'LOW', 'Configuration drift');
  assert(detectVersionDrift('v1', ['v1']) === 'NO_DRIFT', 'Version drift');
  assert(detectVersionDrift('v1', ['v2']) === 'HIGH', 'Version drift detection');

  // Health/risk/blast
  assert(evaluateFleetHealth(goodHealth) === 'HEALTHY', 'Fleet health');
  assert(assessFleetRisk(goodRiskInput) === 'LOW', 'Fleet risk');
  assert(calculateFleetBlastRadius(1,0,0,0) === 'LOW', 'Blast radius');
  const corr = correlateFleetChange(fleet.fleetId, 'chg1', new Date().toISOString(), new Date().toISOString());
  assert(corr.correlationId.length > 0, 'Change correlation');

  // Rollout
  const wave = createRolloutWave(fleet.fleetId, 1, 'canary', 'prod', 'health');
  assert(wave.waveId.length > 0, 'Rollout wave creation');
  const plan = createFleetRolloutPlan({ fleetId: fleet.fleetId, targetEnvironments: ['prod'], desiredVersion: 'v1', desiredConfig: 'cfg1', waves: ['wave1'], healthGates: ['health'], safetyGates: ['safety'], governanceRequirements: ['gov'], rollbackStrategy: 'rollback', blastRadius: 'LOW', dependencies: [], risk: 'LOW', evidenceRequirements: [] });
  assert(plan.planId.length > 0, 'Rollout plan creation');
  const dupPlan = createFleetRolloutPlan({ fleetId: fleet.fleetId, targetEnvironments: ['prod'], desiredVersion: 'v1', desiredConfig: 'cfg1', waves: ['wave1'], healthGates: ['health'], safetyGates: ['safety'], governanceRequirements: ['gov'], rollbackStrategy: 'rollback', blastRadius: 'LOW', dependencies: [], risk: 'LOW', evidenceRequirements: [] });
  assert(dupPlan.idempotencyKey === plan.idempotencyKey, 'Duplicate rollout prevention');

  // Governance/safety
  assert(governFleetAction(goodGovernance) === 'ALLOW', 'Governance allow');
  assert(governFleetAction({ ...goodGovernance, blastRadius: 'CRITICAL' }) === 'REQUIRE_APPROVAL', 'Approval requirement');
  assert(governFleetAction({ ...goodGovernance, protectedResource: true }) === 'DENY', 'Governance denial');
  assert(evaluateFleetSafety(goodSafety).allowed, 'Safety allow');
  assert(!evaluateFleetSafety({ ...goodSafety, destructiveAction: true }).allowed, 'Safety block');

  // Execution
  let exec = createFleetExecution({ planId: plan.planId });
  assert(exec.executionId.length > 0, 'Execution creation');
  exec = transitionFleetExecution(exec, 'APPROVED');
  exec = transitionFleetExecution(exec, 'RUNNING');
  assert(exec.status === 'RUNNING', 'Valid execution transition');
  try { transitionFleetExecution(exec, 'PLANNED'); assert(false, 'Should throw'); } catch { assert(true, 'Invalid execution transition'); }

  // Health gate
  assert(evaluateHealthGate(...Object.values(getGoodRequest().healthGateInput) as any) === 'PASS', 'Health gate');
  assert(evaluateHealthGate('UNKNOWN', 0,0,'UNKNOWN',0,0,'UNKNOWN','UNKNOWN','UNKNOWN','UNKNOWN') === 'UNKNOWN', 'Unknown health fails closed');

  // Rollout progression/halt
  const halt = createFleetHalt(exec.executionId, 'test');
  assert(halt.haltId.length > 0, 'Rollout halt');
  const rollback = createFleetRollback(exec.executionId);
  assert(rollback.rollbackId.length > 0, 'Rollback creation');
  assert(createFleetRollback(exec.executionId).idempotencyKey === rollback.idempotencyKey, 'Rollback safety/idempotency');

  // Remediation
  const remPlan = createFleetRemediationPlan({ fleetId: fleet.fleetId, actions: ['fix_drift'], risk: 'LOW', blastRadius: 'LOW' });
  assert(remPlan.planId.length > 0, 'Remediation plan');
  let remExec = createFleetRemediationExecution({ planId: remPlan.planId });
  remExec = transitionFleetRemediationExecution(remExec, 'APPROVED');
  remExec = transitionFleetRemediationExecution(remExec, 'RUNNING');
  remExec = transitionFleetRemediationExecution(remExec, 'SUCCEEDED');
  assert(remExec.status === 'SUCCEEDED', 'Remediation execution');
  assert(createFleetRemediationRollback(remExec.executionId).rollbackId.length > 0, 'Remediation rollback');

  // Circuit breaker
  assert(evaluateFleetCircuitBreaker(2,3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateFleetCircuitBreaker(3,3) === 'OPEN', 'Circuit breaker opens');

  // Incident/escalation
  const incident = createFleetIncident({ fleetId: fleet.fleetId, type: 'rollout_failure', severity: 'HIGH', status: 'OPEN' });
  assert(incident.incidentId.length > 0, 'Incident creation');
  const dupIncident = createFleetIncident({ fleetId: fleet.fleetId, type: 'rollout_failure', severity: 'HIGH', status: 'OPEN' });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');
  assert(determineEscalation('CRITICAL', true, 'CRITICAL', true, true, false) === 'CRITICAL', 'Escalation');

  // Evidence/audit/lineage/learning
  const evidence = createFleetEvidence({ fleetId: fleet.fleetId, type: 'test', data: {} });
  assert(evidence.evidenceId.length > 0, 'Evidence generation');
  const audit = createFleetAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');
  const lineage: FleetLineage = { rootId: fleet.fleetId, nodes: [] };
  const line1 = addFleetLineageNode(lineage, { version: 1, fleetId: fleet.fleetId, timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Lineage');
  const learning = createFleetLearningRecord({ operationType: 'rollout', success: true, duration: 0 });
  assert(learning.createdAt.length > 0, 'Learning outcome');

  // Provider honesty
  const providerResult = await unconfiguredFleetProvider.executeAction('deploy', {});
  assert(!providerResult.success, 'Unknown provider fails closed');

  // Orchestrator
  const result = await orchestrateFleetOperations(getGoodRequest());
  assert(result.status === 'COMPLETED', 'Full approved lifecycle orchestration');
  const repeat = await orchestrateFleetOperations(getGoodRequest());
  assert(repeat.fleet.idempotencyKey === result.fleet.idempotencyKey, 'Repeated identical fleet request remains idempotent');

  // Redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API-key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization-header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 31: FAIL'); process.exit(1); }
  else { console.log('PHASE 31: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
