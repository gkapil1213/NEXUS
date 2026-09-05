import { createSecuritySignal } from './worker-phase27-security-signal';
import { detectThreat, createSecurityDetection } from './worker-phase27-threat-detection';
import { correlateThreats } from './worker-phase27-threat-correlation';
import { assessSecurityRisk } from './worker-phase27-security-risk';
import { calculateSecurityBlastRadius, DependencyGraph } from './worker-phase27-security-blast-radius';
import { createSecurityIncident, transitionSecurityIncident } from './worker-phase27-security-incident';
import { createResponsePlan } from './worker-phase27-response-plan';
import { evaluateSecurityGovernance } from './worker-phase27-security-governance';
import { createContainmentExecution, transitionContainment } from './worker-phase27-containment-execution';
import { createRemediationPlan } from './worker-phase27-remediation-plan';
import { createRemediationExecution, transitionRemediationExecution } from './worker-phase27-remediation-execution';
import { evaluateRemediationSafety } from './worker-phase27-remediation-safety';
import { evaluateSecurityCircuitBreaker } from './worker-phase27-security-circuit-breaker';
import { verifySecurityResponse } from './worker-phase27-security-verification';
import { createSecurityRollback } from './worker-phase27-security-rollback';
import { createSecurityEscalation } from './worker-phase27-security-escalation';
import { createSecurityEvidence } from './worker-phase27-security-evidence';
import { createSecurityAuditEvent } from './worker-phase27-security-audit';
import { addSecurityLineageNode, SecurityLineage } from './worker-phase27-security-lineage';
import { createSecurityLearningRecord } from './worker-phase27-security-learning';
import { SecurityProvider, unconfiguredSecurityProvider } from './worker-phase27-security-provider';

export interface AutonomousSecurityRequest {
  tenantId: string;
  correlationId: string;
  signalInput: Omit<Parameters<typeof createSecuritySignal>[0], 'correlationId'>;
  riskInput: Parameters<typeof assessSecurityRisk>[0];
  graph: DependencyGraph;
  governanceInput: Parameters<typeof evaluateSecurityGovernance>[0];
  safetyInput: Parameters<typeof evaluateRemediationSafety>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  provider?: SecurityProvider;
  verificationInput: Parameters<typeof verifySecurityResponse>[0];
}

export async function orchestrateSecurityOperations(request: AutonomousSecurityRequest) {
  const auditEvents: ReturnType<typeof createSecurityAuditEvent>[] = [];
  const evidence: ReturnType<typeof createSecurityEvidence>[] = [];
  const provider = request.provider ?? unconfiguredSecurityProvider;

  const signal = createSecuritySignal({ ...request.signalInput, correlationId: request.correlationId });
  const detectionResult = detectThreat(signal);
  const detection = detectionResult.detected ? createSecurityDetection({ signalId: signal.signalId, rule: detectionResult.rule, confidence: detectionResult.confidence, explanation: detectionResult.explanation, assetId: signal.assetId, potentialImpact: 'unknown', provenance: 'rule' }) : null;
  const correlated = correlateThreats([{ signalId: signal.signalId, assetId: signal.assetId, category: signal.category }]);
  const blastRadius = calculateSecurityBlastRadius(request.graph, signal.assetId);
  const risk = assessSecurityRisk(request.riskInput);
  const incident = createSecurityIncident({ title: signal.category, severity: signal.severity, signalIds: [signal.signalId] });
  const plan = createResponsePlan({ incidentId: incident.incidentId, actions: ['isolate'], risk: risk.risk });
  const governance = evaluateSecurityGovernance(request.governanceInput);
  const safety = evaluateRemediationSafety(request.safetyInput);
  const breaker = evaluateSecurityCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);

  if (governance === 'DENY' || !safety.allowed || breaker === 'OPEN') {
    auditEvents.push(createSecurityAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, incidentId: incident.incidentId, eventType: 'SECURITY_BLOCKED', reason: `governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: `governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, signal, detection, correlated, risk, incident, plan, auditEvents, evidence, lineage: { rootId: incident.incidentId, nodes: [] } };
  }

  let containment = createContainmentExecution({ incidentId: incident.incidentId, action: 'isolate' });
  containment = transitionContainment(containment, 'AUTHORIZED');
  containment = transitionContainment(containment, 'RUNNING');
  containment = transitionContainment(containment, 'SUCCEEDED');

  const remediationPlan = createRemediationPlan({ incidentId: incident.incidentId, actions: ['patch'], risk: risk.risk });
  let remediationExec = createRemediationExecution({ planId: remediationPlan.planId });
  remediationExec = transitionRemediationExecution(remediationExec, 'AUTHORIZED');
  remediationExec = transitionRemediationExecution(remediationExec, 'RUNNING');
  remediationExec = transitionRemediationExecution(remediationExec, 'SUCCEEDED');

  const verification = verifySecurityResponse(request.verificationInput);
  const rollback = verification === 'VERIFIED' ? null : createSecurityRollback(remediationExec.remediationId);
  const escalation = verification === 'FAILED' ? createSecurityEscalation(incident.incidentId, 'verification failed') : null;

  evidence.push(createSecurityEvidence({ incidentId: incident.incidentId, type: 'response', data: { containment: 'success', remediation: 'success', verification } }));
  auditEvents.push(createSecurityAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, incidentId: incident.incidentId, eventType: 'SECURITY_RESPONSE', reason: 'response completed', decision: verification }));
  const lineage: SecurityLineage = { rootId: incident.incidentId, nodes: [] };
  addSecurityLineageNode(lineage, { version: 1, incidentId: incident.incidentId, signalId: signal.signalId, remediationId: remediationExec.remediationId, timestamp: new Date().toISOString() });

  const learning = createSecurityLearningRecord({ incidentType: incident.title, remediationType: 'patch', success: verification === 'VERIFIED', duration: 0, recurrence: 0 });

  return { status: 'COMPLETED', signal, detection, correlated, risk, incident, plan, governance, containment, remediationPlan, remediationExec, verification, rollback, escalation, evidence, auditEvents, lineage, learning };
}
