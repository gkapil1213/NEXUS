import { createApplicationResource } from './worker-phase30-application-resource';
import { createService } from './worker-phase30-service';
import { evaluateRuntimeHealth } from './worker-phase30-runtime-health';
import { createRuntimeTelemetry } from './worker-phase30-runtime-telemetry';
import { evaluateSLO } from './worker-phase30-slo';
import { detectAnomaly, createRuntimeAnomaly } from './worker-phase30-anomaly';
import { createServiceDependency } from './worker-phase30-dependency';
import { createRootCauseCandidate } from './worker-phase30-root-cause';
import { analyzeImpact } from './worker-phase30-impact';
import { createRemediationPlan } from './worker-phase30-remediation-plan';
import { governRuntimeAction } from './worker-phase30-remediation-governance';
import { evaluateRemediationSafety } from './worker-phase30-remediation-safety';
import { createRemediationExecution, transitionRemediationExecution } from './worker-phase30-remediation-execution';
import { createRemediationRollback } from './worker-phase30-remediation-rollback';
import { verifyRemediation } from './worker-phase30-remediation-verification';
import { evaluateCircuitBreaker } from './worker-phase30-remediation-circuit-breaker';
import { createRuntimeIncident } from './worker-phase30-incident';
import { determineEscalation } from './worker-phase30-escalation';
import { createRuntimeEvidence } from './worker-phase30-evidence';
import { createRuntimeAuditEvent } from './worker-phase30-audit';
import { addRuntimeLineageNode, RuntimeLineage } from './worker-phase30-lineage';
import { createRuntimeLearningRecord } from './worker-phase30-learning';
import { RuntimeProvider, unconfiguredRuntimeProvider } from './worker-phase30-provider';

export interface AutonomousRuntimeRequest {
  tenantId: string;
  correlationId: string;
  resource: Omit<Parameters<typeof createApplicationResource>[0], 'correlationId'>;
  service: Omit<Parameters<typeof createService>[0], 'correlationId'>;
  health: Parameters<typeof evaluateRuntimeHealth>[0];
  telemetry: Omit<Parameters<typeof createRuntimeTelemetry>[0], 'serviceId' | 'correlationId'>;
  slo: Parameters<typeof evaluateSLO>[0];
  anomaly: Omit<Parameters<typeof createRuntimeAnomaly>[0], 'serviceId' | 'correlationId'>;
  governanceInput: Parameters<typeof governRuntimeAction>[0];
  safetyInput: Parameters<typeof evaluateRemediationSafety>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  provider?: RuntimeProvider;
  verificationInput: Parameters<typeof verifyRemediation>[0];
}

export async function orchestrateRuntimeOperations(request: any) {
  const auditEvents: ReturnType<typeof createRuntimeAuditEvent>[] = [];
  const evidence: ReturnType<typeof createRuntimeEvidence>[] = [];
  const provider = request.provider ?? unconfiguredRuntimeProvider;

  const resource = createApplicationResource({ ...request.resource, correlationId: request.correlationId });
  const service = createService({ ...request.service, correlationId: request.correlationId });
  const health = evaluateRuntimeHealth(request.health);
  const telemetry = createRuntimeTelemetry({ ...request.telemetry, serviceId: service.serviceId, correlationId: request.correlationId });
  const sloResult = evaluateSLO(request.slo.currentValue, request.slo.target, request.slo.burnRate);
  const anomaly = detectAnomaly(service.serviceId, request.anomaly.metric, request.anomaly.value, request.anomaly.baseline, request.anomaly.threshold);
  const dependency = createServiceDependency({ serviceId: service.serviceId, dependsOnServiceId: 'external', dependencyType: 'http', criticality: 'MEDIUM', health: 'HEALTHY', latency: 10, failures: 0 });
  const rootCause = createRootCauseCandidate({ serviceId: service.serviceId, category: anomaly ? anomaly.type : 'UNKNOWN', confidence: 0.5, evidence: [], explanation: 'candidate' });
  const impact = analyzeImpact({ affectedServices: 1, affectedApplications: 1, affectedEnvironments: 1, customerImpact: false, criticality: service.criticality, blastRadius: 1 });

  const governance = governRuntimeAction(request.governanceInput);
  const safety = evaluateRemediationSafety(request.safetyInput);
  const breaker = evaluateCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);

  if (governance === 'DENY' || governance === 'FREEZE' || !safety.allowed || breaker === 'OPEN') {
    auditEvents.push(createRuntimeAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'RUNTIME_BLOCKED', reason: `governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: `governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, resource, service, health, telemetry, sloResult, anomaly, dependency, rootCause, impact, governance, safety, auditEvents, evidence, lineage: { rootId: service.serviceId, nodes: [] } };
  }

  // Execute remediation
  const plan = createRemediationPlan({ serviceId: service.serviceId, actions: ['restart'], reason: 'unhealthy', risk: 'LOW', blastRadius: 'LOW', governanceRequirement: 'ALLOW', rollbackStrategy: 'restore', verificationStrategy: 'health_check' });
  let exec = createRemediationExecution({ planId: plan.planId });
  exec = transitionRemediationExecution(exec, 'APPROVED');
  exec = transitionRemediationExecution(exec, 'EXECUTING');
  const providerResult = await provider.executeAction('restart', { serviceId: service.serviceId });
  if (!providerResult.success) {
    const failedExec = transitionRemediationExecution(exec, 'FAILED');
    return { status: 'FAILED', reason: providerResult.reason, resource, service, health, telemetry, sloResult, anomaly, dependency, rootCause, impact, plan, execution: failedExec, governance, safety, auditEvents, evidence, lineage: { rootId: service.serviceId, nodes: [] } };
  }
  exec = transitionRemediationExecution(exec, 'SUCCEEDED');

  const verification = verifyRemediation(request.verificationInput);
  const rollback = verification === 'VERIFIED' ? null : createRemediationRollback(exec.executionId);
  const escalation = verification === 'FAILED' ? determineEscalation('HIGH', 0, true, 'HIGH', false, false) : 'NONE';

  evidence.push(createRuntimeEvidence({ serviceId: service.serviceId, type: 'remediation', data: { result: verification } }));
  auditEvents.push(createRuntimeAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'RUNTIME_SUCCESS', reason: 'remediation completed', decision: verification }));
  const lineage: RuntimeLineage = { rootId: service.serviceId, nodes: [] };
  addRuntimeLineageNode(lineage, { version: 1, serviceId: service.serviceId, operationId: exec.executionId, timestamp: new Date().toISOString() });
  const learning = createRuntimeLearningRecord({ condition: anomaly ? anomaly.type : 'unknown', remediation: 'restart', success: verification === 'VERIFIED', duration: 0 });

  return { status: 'COMPLETED', resource, service, health, telemetry, sloResult, anomaly, dependency, rootCause, impact, plan, execution: exec, verification, rollback, escalation, evidence, auditEvents, lineage, learning };
}
