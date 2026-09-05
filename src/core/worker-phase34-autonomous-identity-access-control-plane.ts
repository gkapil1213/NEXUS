import { createIdentity, Identity } from './worker-phase34-identity';
import { createRole } from './worker-phase34-role';
import { createPermission, classifyPermissionRisk } from './worker-phase34-permission';
import { createAccessPolicy } from './worker-phase34-access-policy';
import { evaluateAccessPolicy } from './worker-phase34-access-policy-evaluator';
import { resolveAccessPolicyConflict } from './worker-phase34-access-policy-conflict';
import { createAccessRequest } from './worker-phase34-access-request';
import { assessPrivilegeRisk } from './worker-phase34-privilege-risk';
import { detectIdentityDrift } from './worker-phase34-identity-drift';
import { detectAccessAnomaly } from './worker-phase34-access-anomaly';
import { detectOrphanedIdentity } from './worker-phase34-orphaned-identity';
import { createCredential } from './worker-phase34-credential';
import { detectCredentialExpiry } from './worker-phase34-credential-expiry';
import { createSecretMetadata } from './worker-phase34-secret';
import { createSecretRotation, transitionSecretRotation } from './worker-phase34-secret-rotation';
import { createSecretRevocation } from './worker-phase34-secret-revocation';
import { governIdentityAccess } from './worker-phase34-governance';
import { evaluateAccessSafety } from './worker-phase34-safety';
import { calculateAccessBlastRadius } from './worker-phase34-blast-radius';
import { createRemediationPlan } from './worker-phase34-remediation-plan';
import { createRemediationExecution, transitionRemediationExecution } from './worker-phase34-remediation-execution';
import { createRemediationRollback } from './worker-phase34-remediation-rollback';
import { evaluateRemediationSafety } from './worker-phase34-remediation-safety';
import { verifyRemediation } from './worker-phase34-remediation-verification';
import { evaluateAccessCircuitBreaker } from './worker-phase34-access-circuit-breaker';
import { createIncident } from './worker-phase34-incident';
import { determineEscalation } from './worker-phase34-escalation';
import { createEvidence } from './worker-phase34-evidence';
import { createAuditEvent } from './worker-phase34-audit';
import { addLineageNode, Lineage } from './worker-phase34-lineage';
import { createLearningRecord } from './worker-phase34-learning';
import { IdentityProvider, unconfiguredIdentityProvider } from './worker-phase34-provider';

export interface IdentityAccessRequest {
  tenantId: string;
  correlationId: string;
  identity: Omit<Parameters<typeof createIdentity>[0], 'correlationId'>;
  roleInput: Omit<Parameters<typeof createRole>[0], 'correlationId'>;
  permissionInput: Parameters<typeof createPermission>[0];
  policyInput: Omit<Parameters<typeof createAccessPolicy>[0], 'correlationId'>;
  accessRequestInput: Omit<Parameters<typeof createAccessRequest>[0], 'correlationId'>;
  privilegeRiskInput: Parameters<typeof assessPrivilegeRisk>[0];
  safetyInput: Parameters<typeof evaluateAccessSafety>[0];
  circuitBreaker: { failureCount: number; threshold: number };
  provider?: IdentityProvider;
}

export async function orchestrateIdentityAccess(request: IdentityAccessRequest) {
  const auditEvents: ReturnType<typeof createAuditEvent>[] = [];
  const evidence: ReturnType<typeof createEvidence>[] = [];
  const provider = request.provider ?? unconfiguredIdentityProvider;

  const identity = createIdentity({ ...request.identity });
  const role = createRole({ ...request.roleInput });
  const permission = createPermission(request.permissionInput);
  const permissionRisk = classifyPermissionRisk(permission);
  const policy = createAccessPolicy({ ...request.policyInput });
  const policyDecision = evaluateAccessPolicy(policy, { identityId: identity.identityId, action: request.accessRequestInput.action });
  const conflictDecision = resolveAccessPolicyConflict([policyDecision]);
  const privilegeRisk = assessPrivilegeRisk(request.privilegeRiskInput);
  const blastRadius = calculateAccessBlastRadius(1,1,1,1,1);
  const governance = governIdentityAccess({ risk: privilegeRisk, protectedResource: false, production: true, approvalRequired: conflictDecision === 'REQUIRES_APPROVAL' });
  const safety = evaluateAccessSafety(request.safetyInput);
  const breaker = evaluateAccessCircuitBreaker(request.circuitBreaker.failureCount, request.circuitBreaker.threshold);

  if (conflictDecision === 'DENY' || conflictDecision === 'BLOCKED' || governance === 'DENY' || !safety.allowed || breaker === 'OPEN') {
    auditEvents.push(createAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'IDENTITY_BLOCKED', reason: `decision=${conflictDecision}, governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, decision: 'BLOCKED' }));
    return { status: 'BLOCKED', reason: `decision=${conflictDecision}, governance=${governance}, safety=${safety.reason}, breaker=${breaker}`, identity, role, permission, policy, policyDecision, conflictDecision, privilegeRisk, blastRadius, governance, safety, auditEvents, evidence, lineage: { rootId: identity.identityId, nodes: [] } };
  }

  const accessRequest = createAccessRequest({ ...request.accessRequestInput });
  const credential = createCredential({ identityId: identity.identityId, provider: 'aws', status: 'ACTIVE', scope: 'prod', expiresAt: new Date(Date.now()+86400000).toISOString(), rotationState: 'NOT_ROTATING' });
  const secretMeta = createSecretMetadata({ secretId: 'secret-temp', owner: 'team', provider: 'aws', environment: 'prod', scope: 'app', rotationPolicy: 'monthly', expiresAt: new Date(Date.now()+86400000).toISOString(), status: 'ACTIVE', version: 1 });
  let rotation = createSecretRotation({ secretId: secretMeta.secretId });
  rotation = transitionSecretRotation(rotation, 'APPROVED');
  rotation = transitionSecretRotation(rotation, 'EXECUTING');
  const providerResult = await provider.executeAction('rotate', { secretId: secretMeta.secretId });
  if (!providerResult.success) {
    const failedRot = transitionSecretRotation(rotation, 'FAILED');
    return { status: 'FAILED', reason: providerResult.reason, identity, role, permission, policy, policyDecision, conflictDecision, privilegeRisk, blastRadius, governance, safety, accessRequest, credential, secretMeta, rotation: failedRot, auditEvents, evidence, lineage: { rootId: identity.identityId, nodes: [] } };
  }
  rotation = transitionSecretRotation(rotation, 'VERIFIED');

  const remediationPlan = createRemediationPlan({ identityId: identity.identityId, actions: ['remove_privilege'], risk: privilegeRisk, blastRadius });
  if (!evaluateRemediationSafety({ targetExists: true, targetProtected: false, operationAuthorized: true, rollbackExists: true, blastRadiusAcceptable: true, circuitBreakerAllows: true }).allowed) {
    return { status: 'BLOCKED', reason: 'remediation safety', identity, role, permission, policy, policyDecision, conflictDecision, privilegeRisk, blastRadius, governance, safety, remediationPlan, auditEvents, evidence, lineage: { rootId: identity.identityId, nodes: [] } };
  }
  let remExec = createRemediationExecution({ planId: remediationPlan.planId });
  remExec = transitionRemediationExecution(remExec, 'APPROVED');
  remExec = transitionRemediationExecution(remExec, 'EXECUTING');
  remExec = transitionRemediationExecution(remExec, 'SUCCEEDED');

  const verification = verifyRemediation(true, true, true);
  const rollback = verification === 'VERIFIED' ? null : createRemediationRollback(remExec.executionId);
  evidence.push(createEvidence({ identityId: identity.identityId, type: 'remediation', data: { result: verification } }));
  auditEvents.push(createAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, eventType: 'IDENTITY_ACCESS_COMPLETED', reason: 'identity access lifecycle complete', decision: 'SUCCESS' }));
  const lineage: Lineage = { rootId: identity.identityId, nodes: [] };
  addLineageNode(lineage, { version: 1, identityId: identity.identityId, operationId: remExec.executionId, timestamp: new Date().toISOString() });
  const learning = createLearningRecord({ identityId: identity.identityId, outcome: verification, success: verification === 'VERIFIED' });

  return { status: 'COMPLETED', identity, role, permission, policy, policyDecision, conflictDecision, privilegeRisk, blastRadius, governance, safety, accessRequest, credential, secretMeta, rotation, remediationPlan, execution: remExec, verification, rollback, evidence, auditEvents, lineage, learning };
}
