import { classifyGovernanceRisk } from './worker-governance-risk';
import { createGovernancePolicy, evaluatePolicy } from './worker-governance-policy';
import { createApprovalRequest, approveRequest, isApprovalValid } from './worker-approval-request';
import { makeGovernanceDecision } from './worker-governance-decision';
import { createGovernanceEvidence } from './worker-governance-evidence';
import { createGovernanceAuditEvent } from './worker-governance-audit';

export interface GovernanceOrchestrationRequest {
  tenantId: string;
  correlationId: string;
  action: string;
  target: string;
  environment: string;
  securitySeverity: string;
  blastRadius: number;
  reversibility: boolean;
  previousFailures: number;
  requesterId: string;
  policy: Parameters<typeof createGovernancePolicy>[0];
  approvalActor?: { actorId: string; role: string };
}

export function orchestrateGovernance(request: GovernanceOrchestrationRequest) {
  const auditEvents: ReturnType<typeof createGovernanceAuditEvent>[] = [];
  const evidence: ReturnType<typeof createGovernanceEvidence>[] = [];

  const risk = classifyGovernanceRisk({
    action: request.action,
    target: request.target,
    environment: request.environment,
    securitySeverity: request.securitySeverity,
    blastRadius: request.blastRadius,
    reversibility: request.reversibility,
    previousFailures: request.previousFailures,
  });

  const policy = createGovernancePolicy({ ...request.policy, status: 'ACTIVE' });
  const policyDecision = evaluatePolicy(policy, risk);

  let approval;
  if (policyDecision === 'REQUIRES_APPROVAL') {
    approval = createApprovalRequest({
      requestFingerprint: `${request.action}:${request.target}:${request.correlationId}`,
      action: request.action,
      target: request.target,
      riskLevel: risk,
      policyVersion: policy.version,
      policyFingerprint: policy.fingerprint,
      requiredApprovals: policy.minApprovals,
      minApprovers: policy.minApprovals,
      separateDuties: policy.requireSeparationOfDuties,
      requesterId: request.requesterId,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    if (request.approvalActor) {
      const result = approveRequest(approval, request.approvalActor, policy.requireSeparationOfDuties);
      approval = result.request;
    }
  }

  const decision = makeGovernanceDecision({
    requestFingerprint: `${request.action}:${request.target}:${request.correlationId}`,
    policy: { status: policy.status, decision: policyDecision },
    riskLevel: risk,
    approval: approval ? { status: approval.status, valid: isApprovalValid(approval) } : undefined,
  });

  if (decision !== 'ALLOW') {
    auditEvents.push(createGovernanceAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, requestFingerprint: `${request.action}:${request.target}:${request.correlationId}`, eventType: 'GOVERNANCE_DENIED', reason: `decision=${decision}`, decision }));
    return { status: 'BLOCKED', reason: decision, risk, policy, policyDecision, approval, decision, auditEvents, evidence };
  }

  auditEvents.push(createGovernanceAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, requestFingerprint: `${request.action}:${request.target}:${request.correlationId}`, eventType: 'GOVERNANCE_ALLOWED', reason: 'allowed', decision: 'ALLOW' }));
  evidence.push(createGovernanceEvidence({ requestFingerprint: `${request.action}:${request.target}:${request.correlationId}`, policyFingerprint: policy.fingerprint, policyVersion: policy.version, riskDecision: risk, approvalState: approval?.status ?? 'NONE', decision: decision, reason: 'governance approved', emergency: false }));

  return { status: 'COMPLETED', risk, policy, policyDecision, approval, decision, auditEvents, evidence };
}
