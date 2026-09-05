import { createProductionEnvironment, checkEnvironmentAvailability } from './worker-production-environment';
import { runPreflight } from './worker-production-preflight';
import { createProductionRelease, transitionRelease } from './worker-production-release';
import { createDeploymentExecution, transitionDeploymentExecution } from './worker-production-deployment-executor';
import { evaluateRollout } from './worker-production-rollout-controller';
import { evaluateHealth } from './worker-production-health';
import { createProductionIncident } from './worker-production-incident';
import { createRemediationAction } from './worker-production-remediation';
import { evaluateCircuitBreaker } from './worker-production-circuit-breaker';
import { evaluateDrift } from './worker-production-drift';
import { unavailableDeploymentTarget, DeploymentTargetAdapter } from './worker-production-deployment-target';
import { createProductionAuditEvent } from './worker-production-audit';
import { createProductionEvidence } from './worker-production-evidence';
import { addProductionLineageNode, ProductionLineage } from './worker-production-lineage';

export interface ProductionOperationsRequest {
  tenantId: string;
  correlationId: string;
  environment: Omit<Parameters<typeof createProductionEnvironment>[0], 'correlationId'>;
  preflight: Parameters<typeof runPreflight>[0];
  release: Omit<Parameters<typeof createProductionRelease>[0], 'environmentId' | 'correlationId'>;
  executionMode: 'REAL' | 'DRY_RUN' | 'SIMULATION';
  rollout: Parameters<typeof evaluateRollout>[0];
  health: Parameters<typeof evaluateHealth>[0];
  risk: { lowRisk: boolean; highRisk: boolean };
  governance: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  safety: 'ALLOW' | 'DENY';
  circuitBreaker: Parameters<typeof evaluateCircuitBreaker>[0];
  drift: Parameters<typeof evaluateDrift>[0];
  targetAdapter?: DeploymentTargetAdapter;
  idempotencyKey?: string;
}

export interface ProductionOperationsResult {
  status: 'COMPLETED' | 'BLOCKED' | 'UNAVAILABLE' | 'FAILED';
  reason?: string;
  environment?: ReturnType<typeof createProductionEnvironment>;
  preflight?: ReturnType<typeof runPreflight>;
  release?: ReturnType<typeof createProductionRelease>;
  execution?: ReturnType<typeof createDeploymentExecution>;
  rollout?: ReturnType<typeof evaluateRollout>;
  health?: ReturnType<typeof evaluateHealth>;
  incident?: ReturnType<typeof createProductionIncident>;
  remediation?: ReturnType<typeof createRemediationAction>;
  circuitBreaker?: ReturnType<typeof evaluateCircuitBreaker>;
  drift?: ReturnType<typeof evaluateDrift>;
  auditEvents: ReturnType<typeof createProductionAuditEvent>[];
  evidence: ReturnType<typeof createProductionEvidence>[];
  lineage: ProductionLineage;
}

export async function orchestrateProductionOperations(request: ProductionOperationsRequest): Promise<ProductionOperationsResult> {
  const auditEvents: ReturnType<typeof createProductionAuditEvent>[] = [];
  const evidence: ReturnType<typeof createProductionEvidence>[] = [];
  const adapter = request.targetAdapter ?? unavailableDeploymentTarget;

  // 1. Environment
  const environment = createProductionEnvironment({ ...request.environment, correlationId: request.correlationId });
  const envAvailability = checkEnvironmentAvailability(environment);
  if (!envAvailability.available) {
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: environment.environmentId, eventType: 'OPERATION_BLOCKED', reason: envAvailability.reason, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: envAvailability.reason, environment, auditEvents, evidence, lineage: { environmentId: environment.environmentId, nodes: [] } };
  }

  // 2. Preflight
  const preflight = runPreflight(request.preflight);
  if (!preflight.passed) {
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: environment.environmentId, eventType: 'PREFLIGHT_FAILED', reason: preflight.reasons.join(', '), decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: preflight.reasons.join(', '), environment, preflight, auditEvents, evidence, lineage: { environmentId: environment.environmentId, nodes: [] } };
  }

  // 3. Governance and Safety
  if (request.governance === 'DENY' || request.safety === 'DENY') {
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: environment.environmentId, eventType: 'OPERATION_DENIED', reason: `governance=${request.governance}, safety=${request.safety}`, decision: 'DENIED' }));
    return { status: 'BLOCKED', reason: 'governance/safety denial', environment, preflight, auditEvents, evidence, lineage: { environmentId: environment.environmentId, nodes: [] } };
  }

  // 4. Circuit breaker
  const circuitBreaker = evaluateCircuitBreaker(request.circuitBreaker);
  if (circuitBreaker === 'OPEN') {
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: environment.environmentId, eventType: 'CIRCUIT_OPEN', reason: 'circuit breaker open', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'circuit breaker open', environment, preflight, circuitBreaker, auditEvents, evidence, lineage: { environmentId: environment.environmentId, nodes: [] } };
  }

  // 5. Release lifecycle
  let release = createProductionRelease({ ...request.release, environmentId: environment.environmentId, correlationId: request.correlationId });
  release = transitionRelease(release, 'VALIDATED');
  release = transitionRelease(release, 'APPROVED');
  release = transitionRelease(release, 'READY');
  release = transitionRelease(release, 'DEPLOYING');

  // 6. Deployment execution via adapter
  let execution = createDeploymentExecution({
    releaseId: release.releaseId,
    environmentId: environment.environmentId,
    executionMode: request.executionMode,
    evidence: [],
    correlationId: request.correlationId,
  });

  execution = transitionDeploymentExecution(execution, 'APPROVED');
  execution = transitionDeploymentExecution(execution, 'RUNNING');

  const deployResult = await adapter.deploy(request.release.artifactId, request.release.version);
  if (!deployResult.success) {
    const failedExecution = transitionDeploymentExecution(execution, 'FAILED');
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: environment.environmentId, eventType: 'DEPLOYMENT_FAILED', reason: deployResult.reason, decision: 'FAILED' }));
    return { status: 'FAILED', reason: deployResult.reason, environment, preflight, release, execution: failedExecution, circuitBreaker, auditEvents, evidence, lineage: { environmentId: environment.environmentId, nodes: [] } };
  }

  const succeededExecution = transitionDeploymentExecution(execution, 'SUCCEEDED');
  release = transitionRelease(release, 'DEPLOYED');
  release = transitionRelease(release, 'VERIFYING');

  // 7. Health verification
  const health = evaluateHealth(request.health);
  if (health === 'UNHEALTHY' || health === 'UNAVAILABLE') {
    const incident = createProductionIncident({
      environmentId: environment.environmentId,
      releaseId: release.releaseId,
      service: request.release.artifactId,
      severity: 'HIGH',
      evidence: ['health check failed'],
      correlationId: request.correlationId,
    });
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: environment.environmentId, eventType: 'INCIDENT_DETECTED', reason: `health=${health}`, decision: 'INCIDENT' }));
    return { status: 'FAILED', reason: `unhealthy: ${health}`, environment, preflight, release, execution: succeededExecution, health, incident, circuitBreaker, auditEvents, evidence, lineage: { environmentId: environment.environmentId, nodes: [] } };
  }

  // 8. Rollout evaluation
  const rollout = evaluateRollout(request.rollout);
  if (rollout.action === 'PAUSE' || rollout.action === 'ABORT') {
    const incident = createProductionIncident({
      environmentId: environment.environmentId,
      releaseId: release.releaseId,
      service: request.release.artifactId,
      severity: 'MEDIUM',
      evidence: [`rollout ${rollout.action}`],
      correlationId: request.correlationId,
    });
    return { status: 'BLOCKED', reason: `rollout ${rollout.action}`, environment, preflight, release, execution: succeededExecution, rollout, incident, circuitBreaker, auditEvents, evidence, lineage: { environmentId: environment.environmentId, nodes: [] } };
  }

  // 9. Drift
  const drift = evaluateDrift(request.drift);

  // 10. Remediation (if degraded health)
  let remediation;
  if (health === 'DEGRADED') {
    remediation = createRemediationAction({
      incidentId: 'none',
      actionType: 'RESTART',
      environmentId: environment.environmentId,
      target: request.release.artifactId,
      governanceApproved: request.governance === 'ALLOW',
      safetyApproved: request.safety === 'ALLOW',
      evidence: ['degraded health'],
      maxAttempts: 3,
      correlationId: request.correlationId,
    });
  }

  // 11. Evidence
  const deployEvidence = createProductionEvidence({
    tenantId: request.tenantId,
    correlationId: request.correlationId,
    operationId: execution.executionId,
    evidenceType: 'DEPLOYMENT_RESULT',
    data: { result: 'SUCCESS', mode: request.executionMode },
  });
  evidence.push(deployEvidence);

  // 12. Lineage
  const lineage: ProductionLineage = { environmentId: environment.environmentId, nodes: [] };
  addProductionLineageNode(lineage, {
    version: 1,
    requestId: request.correlationId,
    releaseId: release.releaseId,
    executionId: execution.executionId,
    environmentId: environment.environmentId,
    timestamp: new Date().toISOString(),
  });

  // 13. Audit completion
  auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: environment.environmentId, eventType: 'OPERATION_COMPLETED', reason: 'success', decision: 'COMPLETED' }));

  return {
    status: 'COMPLETED',
    environment,
    preflight,
    release,
    execution: succeededExecution,
    rollout,
    health,
    remediation,
    circuitBreaker,
    drift,
    auditEvents,
    evidence,
    lineage,
  };
}
