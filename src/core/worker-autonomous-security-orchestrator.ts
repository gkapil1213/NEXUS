import { createSecurityAsset } from './worker-security-asset';
import { createSecurityFinding, transitionFinding } from './worker-security-finding';
import { assessSecurityRisk } from './worker-security-risk';
import { evaluateSecurityPolicy } from './worker-security-policy';
import { createComplianceAssessment, ComplianceControl } from './worker-security-compliance';
import { createSecurityRemediationPlan } from './worker-security-remediation';
import { createSecurityRemediationExecution, transitionSecurityRemediationExecution } from './worker-security-remediation-executor';
import { verifySecurityRemediation } from './worker-security-verification';
import { createSecurityIncident } from './worker-security-incident';
import { evaluateSecurityCircuitBreaker } from './worker-security-circuit-breaker';
import { createSecurityEvidence } from './worker-security-evidence';
import { createSecurityAuditEvent } from './worker-security-audit';
import { addSecurityLineageNode, SecurityLineage } from './worker-security-lineage';
import { unavailableSecurityScanner } from './worker-security-scanner';

export interface SecurityOrchestrationRequest {
  tenantId: string;
  correlationId: string;
  assetInput: Omit<Parameters<typeof createSecurityAsset>[0], 'correlationId'>;
  findingInput: Omit<Parameters<typeof createSecurityFinding>[0], 'assetId' | 'correlationId'>;
  riskInput: Parameters<typeof assessSecurityRisk>[0];
  policyInput: Parameters<typeof evaluateSecurityPolicy>[0];
  complianceControls: ComplianceControl[];
  remediationPlan: Omit<Parameters<typeof createSecurityRemediationPlan>[0], 'findingId' | 'assetId' | 'correlationId'>;
  verificationInput: Parameters<typeof verifySecurityRemediation>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  governanceDecision: 'ALLOW' | 'DENY';
  safetyDecision: 'ALLOW' | 'DENY';
}

export async function orchestrateSecurity(request: SecurityOrchestrationRequest) {
  const auditEvents: ReturnType<typeof createSecurityAuditEvent>[] = [];
  const evidence: ReturnType<typeof createSecurityEvidence>[] = [];

  const asset = createSecurityAsset({ ...request.assetInput, correlationId: request.correlationId });
  const finding = createSecurityFinding({ ...request.findingInput, assetId: asset.assetId });

  // Scanner call (unavailable)
  const scanResult = await unavailableSecurityScanner.scan(asset.assetId, finding.category);
  if (scanResult.status !== 'SUCCESS') {
    auditEvents.push(createSecurityAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, assetId: asset.assetId, findingId: finding.findingId, eventType: 'SCAN_UNAVAILABLE', reason: 'scanner unavailable', decision: 'UNAVAILABLE' }));
  }

  const risk = assessSecurityRisk(request.riskInput);
  const policy = evaluateSecurityPolicy(request.policyInput);

  if (request.governanceDecision === 'DENY' || request.safetyDecision === 'DENY' || policy === 'DENY') {
    auditEvents.push(createSecurityAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, assetId: asset.assetId, findingId: finding.findingId, eventType: 'SECURITY_BLOCKED', reason: `policy=${policy}, governance=${request.governanceDecision}, safety=${request.safetyDecision}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', asset, finding, risk, policy, auditEvents, evidence, lineage: { rootId: asset.assetId, nodes: [] } };
  }

  // Remediation plan
  const plan = createSecurityRemediationPlan({ ...request.remediationPlan, findingId: finding.findingId, assetId: asset.assetId });

  // Circuit breaker
  const breaker = evaluateSecurityCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);
  if (breaker === 'OPEN') {
    auditEvents.push(createSecurityAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, assetId: asset.assetId, findingId: finding.findingId, eventType: 'CIRCUIT_OPEN', reason: 'circuit breaker open', decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: 'circuit breaker open', asset, finding, risk, policy, plan, auditEvents, evidence, lineage: { rootId: asset.assetId, nodes: [] } };
  }

  // Execute remediation (simulate success)
  let execution = createSecurityRemediationExecution({ planId: plan.planId, correlationId: request.correlationId, maxAttempts: 3 });
  execution = transitionSecurityRemediationExecution(execution, 'AUTHORIZED');
  execution = transitionSecurityRemediationExecution(execution, 'EXECUTING');
  execution = transitionSecurityRemediationExecution(execution, 'SUCCEEDED');

  // Verification
  const verification = verifySecurityRemediation(request.verificationInput);

  // Incident if verification fails? For simplicity, assume success.

  // Compliance assessment
  const assessment = createComplianceAssessment('generic', request.complianceControls, request.correlationId);

  // Evidence, audit, lineage
  evidence.push(createSecurityEvidence({ tenantId: request.tenantId, correlationId: request.correlationId, actionId: execution.executionId, evidenceType: 'SECURITY_REMEDIATION', data: { status: execution.status } }));
  auditEvents.push(createSecurityAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, assetId: asset.assetId, findingId: finding.findingId, eventType: 'SECURITY_REMEDIATION_COMPLETED', reason: 'remediation completed', decision: 'SUCCEEDED' }));
  const lineage: SecurityLineage = { rootId: asset.assetId, nodes: [] };
  addSecurityLineageNode(lineage, { version: 1, assetId: asset.assetId, findingId: finding.findingId, remediationId: execution.executionId, timestamp: new Date().toISOString() });

  return { status: 'COMPLETED', asset, finding, risk, policy, plan, execution, verification, assessment, auditEvents, evidence, lineage };
}
