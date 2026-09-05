import { createProductionSignal } from './worker-production-intelligence-signal';
import { detectAnomaly } from './worker-production-intelligence-anomaly';
import { correlateSignals } from './worker-production-intelligence-correlation';
import { generateHypothesis } from './worker-production-intelligence-hypothesis';
import { assessProductionRisk } from './worker-production-intelligence-risk';
import { createRemediationPlan } from './worker-production-intelligence-remediation';
import { createRemediationExecution, transitionRemediationExecution } from './worker-production-intelligence-remediation-executor';
import { verifyRemediation } from './worker-production-intelligence-remediation-verification';
import { evaluateRemediationCircuitBreaker } from './worker-production-intelligence-circuit-breaker';
import { createProductionLearningRecord } from './worker-production-intelligence-learning';
import { createProductionAuditEvent } from './worker-production-audit';
import { createProductionEvidence } from './worker-production-evidence';

export interface ProductionIntelligenceRequest {
  tenantId: string;
  correlationId: string;
  signalInput: Omit<Parameters<typeof createProductionSignal>[0], 'correlationId'>;
  anomalyThresholds: { warning: number; critical: number };
  governanceDecision: 'ALLOW' | 'DENY';
  safetyDecision: 'ALLOW' | 'DENY';
  riskInput: Parameters<typeof assessProductionRisk>[0];
  remediationPlan: Omit<Parameters<typeof createRemediationPlan>[0], 'incidentId' | 'hypothesisId' | 'correlationId'>;
  verificationInput: Parameters<typeof verifyRemediation>[0];
  circuitBreaker: { failureCount: number; threshold: number };
}

export function orchestrateProductionIntelligence(request: ProductionIntelligenceRequest) {
  const auditEvents: ReturnType<typeof createProductionAuditEvent>[] = [];
  const evidence: ReturnType<typeof createProductionEvidence>[] = [];

  // 1. Create signal
  const signal = createProductionSignal({ ...request.signalInput });

  // 2. Detect anomaly
  const anomaly = detectAnomaly({ signal, thresholds: request.anomalyThresholds });

  // 3. Correlate (with itself, simulate at least one group)
  const correlated = correlateSignals([{ signalId: signal.signalId, serviceId: signal.serviceId, environmentId: signal.environmentId, timestamp: signal.timestamp, deploymentContext: signal.deploymentContext }], 3600000);

  // 4. Hypothesis
  const hypothesis = generateHypothesis({ category: anomaly === 'CRITICAL' ? 'deployment regression' : 'unknown', supportingSignals: [signal.signalId], confidence: anomaly === 'CRITICAL' ? 0.7 : 0.3 });

  // 5. Risk
  const risk = assessProductionRisk(request.riskInput);

  // 6. Remediation plan (if allowed)
  const plan = createRemediationPlan({ ...request.remediationPlan, incidentId: 'inc-1', hypothesisId: hypothesis.hypothesisId });

  // 7. Governance/Safety
  if (request.governanceDecision === 'DENY' || request.safetyDecision === 'DENY') {
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: signal.environmentId, eventType: 'REMEDIATION_BLOCKED', reason: 'governance/safety denial', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', signal, anomaly, hypothesis, risk, plan, auditEvents, evidence };
  }

  // 8. Circuit breaker
  const breakerState = evaluateRemediationCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);
  if (breakerState === 'OPEN') {
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: signal.environmentId, eventType: 'CIRCUIT_OPEN', reason: 'circuit breaker open', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'circuit breaker open', signal, anomaly, hypothesis, risk, plan, auditEvents, evidence };
  }

  // 9. Execute remediation
  let execution = createRemediationExecution({ planId: plan.planId, correlationId: request.correlationId, maxAttempts: 3 });
  execution = transitionRemediationExecution(execution, 'AUTHORIZED');
  execution = transitionRemediationExecution(execution, 'EXECUTING');
  execution = transitionRemediationExecution(execution, 'SUCCEEDED');

  // 10. Verify
  const verification = verifyRemediation(request.verificationInput);

  // 11. Learning
  const learning = createProductionLearningRecord({
    tenantId: request.tenantId,
    incidentId: 'inc-1',
    hypothesisId: hypothesis.hypothesisId,
    remediationId: execution.executionId,
    outcome: verification.status,
    failureClassification: 'NONE',
    confidence: hypothesis.confidence,
    evidence: ['signal'],
    durationMs: 100,
    correlationId: request.correlationId,
  });

  // 12. Evidence, Audit
  evidence.push(createProductionEvidence({ tenantId: request.tenantId, correlationId: request.correlationId, operationId: execution.executionId, evidenceType: 'REMEDIATION_VERIFICATION', data: { status: verification.status } }));
  auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: signal.environmentId, eventType: 'REMEDIATION_COMPLETED', reason: `verification=${verification.status}`, decision: 'COMPLETED' }));

  return { status: 'COMPLETED', signal, anomaly, correlated, hypothesis, risk, plan, execution, verification, learning, auditEvents, evidence };
}
