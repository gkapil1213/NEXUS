import { createPlatformEnvironment } from './worker-phase31-environment';
import { createFleet } from './worker-phase31-fleet';
import { evaluateEnvironmentHealth } from './worker-phase31-environment-health';
import { evaluateFleetHealth } from './worker-phase31-fleet-health';
import { detectConfigDrift } from './worker-phase31-configuration-drift';
import { detectVersionDrift } from './worker-phase31-version-drift';
import { assessFleetRisk } from './worker-phase31-fleet-risk';
import { calculateFleetBlastRadius } from './worker-phase31-fleet-blast-radius';
import { correlateFleetChange } from './worker-phase31-fleet-change-correlation';
import { createFleetRolloutPlan } from './worker-phase31-fleet-rollout-plan';
import { createFleetExecution, transitionFleetExecution } from './worker-phase31-fleet-execution';
import { evaluateHealthGate } from './worker-phase31-fleet-health-gate';
import { createFleetHalt } from './worker-phase31-fleet-halt';
import { createFleetRollback } from './worker-phase31-fleet-rollback';
import { governFleetAction } from './worker-phase31-fleet-governance';
import { evaluateFleetSafety } from './worker-phase31-fleet-safety';
import { evaluateFleetCircuitBreaker } from './worker-phase31-fleet-circuit-breaker';
import { createFleetIncident } from './worker-phase31-fleet-incident';
import { determineEscalation } from './worker-phase31-fleet-escalation';
import { createFleetEvidence } from './worker-phase31-fleet-evidence';
import { createFleetAuditEvent } from './worker-phase31-fleet-audit';
import { addFleetLineageNode, FleetLineage } from './worker-phase31-fleet-lineage';
import { createFleetLearningRecord } from './worker-phase31-fleet-learning';
import { FleetProvider, unconfiguredFleetProvider } from './worker-phase31-provider';

export interface FleetOrchestrationRequest {
  tenantId: string;
  correlationId: string;
  environment: Omit<Parameters<typeof createPlatformEnvironment>[0], 'correlationId'>;
  fleet: Omit<Parameters<typeof createFleet>[0], 'correlationId'>;
  environmentHealth: Parameters<typeof evaluateEnvironmentHealth>[0];
  fleetHealth: Parameters<typeof evaluateFleetHealth>[0];
  configDesired: string;
  configObserved: string;
  versionDesired: string;
  versionObserved: string[];
  riskInput: Parameters<typeof assessFleetRisk>[0];
  blastRadius: Parameters<typeof calculateFleetBlastRadius>[0];
  governanceInput: Parameters<typeof governFleetAction>[0];
  safetyInput: Parameters<typeof evaluateFleetSafety>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  healthGateInput: Parameters<typeof evaluateHealthGate>[0];
  provider?: FleetProvider;
}

export async function orchestrateFleetOperations(request: any) {
  const auditEvents: ReturnType<typeof createFleetAuditEvent>[] = [];
  const evidence: ReturnType<typeof createFleetEvidence>[] = [];
  const provider = request.provider ?? unconfiguredFleetProvider;

  const environment = createPlatformEnvironment({ ...request.environment, correlationId: request.correlationId });
  const fleet = createFleet({ ...request.fleet, correlationId: request.correlationId });
  const envHealth = evaluateEnvironmentHealth(request.environmentHealth);
  const fleetHealth = evaluateFleetHealth(request.fleetHealth);
  const configDrift = detectConfigDrift(request.configDesired, request.configObserved);
  const versionDrift = detectVersionDrift(request.versionDesired, request.versionObserved);
  const risk = assessFleetRisk(request.riskInput);
  const blastRadius = calculateFleetBlastRadius(request.blastRadius[0], request.blastRadius[1], request.blastRadius[2], request.blastRadius[3]);
  const changeCorr = correlateFleetChange(fleet.fleetId, 'chg1', new Date().toISOString(), new Date().toISOString());
  const governance = governFleetAction(request.governanceInput);
  const safety = evaluateFleetSafety(request.safetyInput);
  const breaker = evaluateFleetCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);

  if (governance === 'DENY' || governance === 'FREEZE' || !safety.allowed || breaker === 'OPEN') {
    auditEvents.push(createFleetAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'FLEET_BLOCKED', reason: `governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: `governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, environment, fleet, envHealth, fleetHealth, configDrift, versionDrift, risk, blastRadius, changeCorr, governance, safety, auditEvents, evidence, lineage: { rootId: fleet.fleetId, nodes: [] } };
  }

  const plan = createFleetRolloutPlan({
    fleetId: fleet.fleetId,
    targetEnvironments: fleet.environmentScope,
    desiredVersion: request.versionDesired,
    desiredConfig: request.configDesired,
    waves: ['canary', 'staging', 'production'],
    healthGates: ['health'],
    safetyGates: ['safety'],
    governanceRequirements: ['governance'],
    rollbackStrategy: 'rollback',
    blastRadius: blastRadius,
    dependencies: [],
    risk,
    evidenceRequirements: ['evidence'],
  });

  let exec = createFleetExecution({ planId: plan.planId });
  exec = transitionFleetExecution(exec, 'APPROVED');
  exec = transitionFleetExecution(exec, 'RUNNING');

  const providerResult = await provider.executeAction('deploy', { fleetId: fleet.fleetId });
  if (!providerResult.success) {
    const failedExec = transitionFleetExecution(exec, 'FAILED');
    auditEvents.push(createFleetAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'FLEET_FAILED', reason: providerResult.reason, decision: 'FAILED' }));
    return { status: 'FAILED', reason: providerResult.reason, environment, fleet, envHealth, fleetHealth, configDrift, versionDrift, risk, blastRadius, changeCorr, governance, safety, plan, execution: failedExec, auditEvents, evidence, lineage: { rootId: fleet.fleetId, nodes: [] } };
  }

  exec = transitionFleetExecution(exec, 'SUCCEEDED');
  const healthGate = evaluateHealthGate(request.healthGateInput[0], request.healthGateInput[1], request.healthGateInput[2], request.healthGateInput[3], request.healthGateInput[4], request.healthGateInput[5], request.healthGateInput[6], request.healthGateInput[7], request.healthGateInput[8], request.healthGateInput[9]);
  const halt = healthGate === 'HALT' ? createFleetHalt(exec.executionId, 'health gate failed') : null;
  const rollback = healthGate === 'HALT' ? createFleetRollback(exec.executionId) : null;

  evidence.push(createFleetEvidence({ fleetId: fleet.fleetId, type: 'rollout', data: { status: exec.status, healthGate } }));
  auditEvents.push(createFleetAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'FLEET_SUCCEEDED', reason: 'fleet rollout completed', decision: 'SUCCESS' }));
  const lineage: FleetLineage = { rootId: fleet.fleetId, nodes: [] };
  addFleetLineageNode(lineage, { version: 1, fleetId: fleet.fleetId, operationId: exec.executionId, timestamp: new Date().toISOString() });
  const learning = createFleetLearningRecord({ operationType: 'rollout', success: true, duration: 0 });

  return { status: 'COMPLETED', environment, fleet, envHealth, fleetHealth, configDrift, versionDrift, risk, blastRadius, changeCorr, governance, safety, plan, execution: exec, healthGate, halt, rollback, evidence, auditEvents, lineage, learning };
}
