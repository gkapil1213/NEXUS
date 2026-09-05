import { createIdentity, transitionIdentity } from '../src/core/worker-phase34-identity';
import { createRole } from '../src/core/worker-phase34-role';
import { createPermission, classifyPermissionRisk } from '../src/core/worker-phase34-permission';
import { createAccessPolicy } from '../src/core/worker-phase34-access-policy';
import { evaluateAccessPolicy } from '../src/core/worker-phase34-access-policy-evaluator';
import { resolveAccessPolicyConflict } from '../src/core/worker-phase34-access-policy-conflict';
import { createAccessRequest } from '../src/core/worker-phase34-access-request';
import { assessPrivilegeRisk } from '../src/core/worker-phase34-privilege-risk';
import { detectIdentityDrift } from '../src/core/worker-phase34-identity-drift';
import { detectAccessAnomaly } from '../src/core/worker-phase34-access-anomaly';
import { detectOrphanedIdentity } from '../src/core/worker-phase34-orphaned-identity';
import { createCredential } from '../src/core/worker-phase34-credential';
import { detectCredentialExpiry } from '../src/core/worker-phase34-credential-expiry';
import { createSecretMetadata } from '../src/core/worker-phase34-secret';
import { createSecretRotation, transitionSecretRotation } from '../src/core/worker-phase34-secret-rotation';
import { createSecretRevocation } from '../src/core/worker-phase34-secret-revocation';
import { governIdentityAccess } from '../src/core/worker-phase34-governance';
import { evaluateAccessSafety } from '../src/core/worker-phase34-safety';
import { calculateAccessBlastRadius } from '../src/core/worker-phase34-blast-radius';
import { createRemediationPlan } from '../src/core/worker-phase34-remediation-plan';
import { createRemediationExecution, transitionRemediationExecution } from '../src/core/worker-phase34-remediation-execution';
import { createRemediationRollback } from '../src/core/worker-phase34-remediation-rollback';
import { evaluateRemediationSafety } from '../src/core/worker-phase34-remediation-safety';
import { verifyRemediation } from '../src/core/worker-phase34-remediation-verification';
import { evaluateAccessCircuitBreaker } from '../src/core/worker-phase34-access-circuit-breaker';
import { createIncident } from '../src/core/worker-phase34-incident';
import { determineEscalation } from '../src/core/worker-phase34-escalation';
import { createEvidence } from '../src/core/worker-phase34-evidence';
import { createAuditEvent } from '../src/core/worker-phase34-audit';
import { addLineageNode, Lineage } from '../src/core/worker-phase34-lineage';
import { createLearningRecord } from '../src/core/worker-phase34-learning';
import { orchestrateIdentityAccess } from '../src/core/worker-phase34-autonomous-identity-access-control-plane';
import { unconfiguredIdentityProvider } from '../src/core/worker-phase34-provider';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodIdentity = { type: 'SERVICE' as const, name: 'svc1', provider: 'aws', environment: 'prod', status: 'ACTIVE' as const, owner: 'team', metadata: {}, correlationId: 'c' };
const goodRole = { name: 'admin', provider: 'aws', protected: true, privileged: true, permissions: [], version: 1, risk: 'CRITICAL' as const, correlationId: 'c' };
const goodPermission = { permissionId: 'p1', provider: 'aws', resource: 'svc1', resourceType: 'service', action: '*', scope: 'prod', environment: 'prod', conditions: {}, sensitivity: 'high', privilegeLevel: 'CRITICAL' as const };
const goodPolicy = { name: 'prod-policy', effect: 'DENY' as const, conditions: { action: '*' }, risk: 'CRITICAL' as const, correlationId: 'c' };
const goodAccessRequest = { identityId: 'id1', resource: 'svc1', action: '*', environment: 'prod', risk: 'CRITICAL' as const, policyDecision: 'DENY', approvalRequired: true, correlationId: 'c' };
const goodProvider = { status: 'CONFIGURED' as const, capabilities: ['rotate'], async executeAction() { return { success: true, reason: 'ok' }; } };

function getGoodRequest() {
  return {
    tenantId: 't', correlationId: 'c',
    identity: goodIdentity,
    roleInput: goodRole,
    permissionInput: goodPermission,
    policyInput: goodPolicy,
    accessRequestInput: goodAccessRequest,
    privilegeRiskInput: { wildcardPermissions: true, adminPermissions: true, crossEnvironmentAccess: false, productionAccess: true, lowTrustIdentity: false, dormantPrivilegedIdentity: false, privilegeEscalationPath: false },
    safetyInput: { protectedIdentity: false, privilegeEscalation: false, unknownProvider: false, unknownAuthorization: false, unsafeRevocation: false },
    circuitBreaker: { failureCount: 0, threshold: 3 },
    provider: goodProvider,
  };
}

async function main() {
  console.log('=== Phase 34: Autonomous Identity, Access & Secrets Operations ===');

  const identity = createIdentity({ ...goodIdentity, status: 'DISCOVERED' });
  assert(identity.identityId.length > 0, 'Identity creation');
  const dupIdentity = createIdentity({ ...goodIdentity, status: 'DISCOVERED' });
  assert(dupIdentity.idempotencyKey === identity.idempotencyKey, 'Duplicate identity prevention');
  const classified = transitionIdentity(identity, 'ACTIVE');
  assert(classified.status === 'ACTIVE', 'Identity lifecycle/classification');
  assert(transitionIdentity(createIdentity({ ...goodIdentity, status: 'UNKNOWN' as const }), 'DISCOVERED').status === 'DISCOVERED', 'Unknown identity handling');

  const role = createRole(goodRole);
  assert(role.roleId.length > 0, 'Role creation');
  const dupRole = createRole(goodRole);
  assert(dupRole.idempotencyKey === role.idempotencyKey, 'Duplicate role prevention');
  const permission = createPermission(goodPermission);
  assert(permission.permissionId.length > 0, 'Permission creation');
  assert(classifyPermissionRisk(goodPermission) === 'CRITICAL', 'Permission risk classification');

  const policy = createAccessPolicy(goodPolicy);
  assert(policy.policyId.length > 0, 'Policy creation');
  assert(evaluateAccessPolicy(policy, { action: '*' }) === 'DENY', 'Policy evaluation');
  assert(resolveAccessPolicyConflict(['DENY', 'ALLOW']) === 'DENY', 'Policy conflict detection');
  assert(evaluateAccessPolicy(createAccessPolicy({ name: 'allow', effect: 'ALLOW', conditions: {}, risk: 'LOW' }), {}) === 'ALLOW', 'Allow decision');
  assert(evaluateAccessPolicy(createAccessPolicy({ name: 'deny', effect: 'DENY', conditions: {}, risk: 'LOW' }), {}) === 'ALLOW' ? false : true, 'Deny decision');
  assert(evaluateAccessPolicy(createAccessPolicy({ name: 'cond', effect: 'CONDITIONAL', conditions: { action: 'read' }, risk: 'MEDIUM' }), { action: 'write' }) === 'DENY', 'Approval requirement/unknown fails closed');

  assert(assessPrivilegeRisk({ wildcardPermissions: true, adminPermissions: true, crossEnvironmentAccess: false, productionAccess: true, lowTrustIdentity: false, dormantPrivilegedIdentity: false, privilegeEscalationPath: false }) === 'CRITICAL', 'Excessive privilege detection');
  assert(detectOrphanedIdentity('', false, true), 'Orphaned identity detection');
  assert(detectIdentityDrift('fp1','fp2') === 'LOW', 'Identity drift detection');
  assert(detectAccessAnomaly({ privileged: true, unusualResource: true, unusualEnvironment: true, unexpectedIdentity: true }) !== null, 'Access anomaly detection');

  const accessReq = createAccessRequest(goodAccessRequest);
  assert(accessReq.requestId.length > 0, 'Access request creation');
  const dupReq = createAccessRequest(goodAccessRequest);
  assert(dupReq.idempotencyKey === accessReq.idempotencyKey, 'Duplicate access request prevention');

  assert(calculateAccessBlastRadius(1,1,1,1,1) === 'HIGH', 'Blast-radius analysis');
  assert(governIdentityAccess({ risk: 'CRITICAL', protectedResource: false, production: true, approvalRequired: true }) === 'REQUIRES_APPROVAL', 'Governance approval requirement');
  assert(governIdentityAccess({ risk: 'CRITICAL', protectedResource: true, production: true, approvalRequired: true }) === 'DENY', 'Governance denial');
  assert(evaluateAccessSafety({ protectedIdentity: false, privilegeEscalation: false, unknownProvider: false, unknownAuthorization: false, unsafeRevocation: false }).allowed, 'Safety allow');
  assert(!evaluateAccessSafety({ protectedIdentity: true, privilegeEscalation: false, unknownProvider: false, unknownAuthorization: false, unsafeRevocation: false }).allowed, 'Safety block');

  const credential = createCredential({ identityId: identity.identityId, provider: 'aws', status: 'ACTIVE', scope: 'prod', expiresAt: new Date(Date.now()+3600000).toISOString(), rotationState: 'none' });
  assert(credential.credentialId.length > 0, 'Credential creation');
  assert(detectCredentialExpiry({ expiresAt: new Date(Date.now()-1000).toISOString() }).expired, 'Credential expiry detection');
  assert(createSecretRevocation('secret1', 'reason').revocationId.length > 0, 'Credential revocation planning');

  const secretMeta = createSecretMetadata({ secretId: 'secret-test', owner: 'team', provider: 'aws', environment: 'prod', scope: 'app', rotationPolicy: 'monthly', expiresAt: new Date(Date.now()+86400000).toISOString(), status: 'ACTIVE', version: 1 });
  assert(secretMeta.secretId.length > 0, 'Secret registration');
  let rotation = createSecretRotation({ secretId: secretMeta.secretId });
  assert(rotation.rotationId.length > 0, 'Secret rotation planning');
  rotation = transitionSecretRotation(rotation, 'APPROVED');
  rotation = transitionSecretRotation(rotation, 'EXECUTING');
  rotation = transitionSecretRotation(rotation, 'VERIFIED');
  assert(rotation.status === 'VERIFIED', 'Secret rotation execution lifecycle');
  try { transitionSecretRotation(rotation, 'EXECUTING'); assert(false, 'Should throw'); } catch { assert(true, 'Secret rotation failure handling'); }

  const remPlan = createRemediationPlan({ identityId: identity.identityId, actions: ['remove_privilege'], risk: 'HIGH', blastRadius: 'LOW' });
  assert(remPlan.planId.length > 0, 'Remediation plan');
  let remExec = createRemediationExecution({ planId: remPlan.planId });
  remExec = transitionRemediationExecution(remExec, 'APPROVED');
  remExec = transitionRemediationExecution(remExec, 'EXECUTING');
  remExec = transitionRemediationExecution(remExec, 'SUCCEEDED');
  assert(remExec.status === 'SUCCEEDED', 'Remediation execution');
  assert(createRemediationRollback(remExec.executionId).rollbackId.length > 0, 'Remediation rollback');
  assert(evaluateRemediationSafety({ targetExists: true, targetProtected: false, operationAuthorized: true, rollbackExists: true, blastRadiusAcceptable: true, circuitBreakerAllows: true }).allowed, 'Remediation safety');

  assert(evaluateAccessCircuitBreaker(2,3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateAccessCircuitBreaker(3,3) === 'OPEN', 'Circuit breaker opens');

  const incident = createIncident({ identityId: identity.identityId, type: 'privilege_escalation', severity: 'CRITICAL', status: 'OPEN' });
  assert(incident.incidentId.length > 0, 'Incident creation');
  const dupIncident = createIncident({ identityId: identity.identityId, type: 'privilege_escalation', severity: 'CRITICAL', status: 'OPEN' });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');
  assert(determineEscalation('CRITICAL', 'LOW', 'HIGH', false) === 'CRITICAL', 'Escalation');

  const evidence = createEvidence({ identityId: identity.identityId, type: 'test', data: {} });
  assert(evidence.evidenceId.length > 0, 'Evidence generation');
  const audit = createAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');
  const lineage: Lineage = { rootId: identity.identityId, nodes: [] };
  const line1 = addLineageNode(lineage, { version: 1, identityId: identity.identityId, timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Lineage');
  const learning = createLearningRecord({ identityId: identity.identityId, outcome: 'VERIFIED', success: true });
  assert(learning.createdAt.length > 0, 'Learning outcome');

  const providerResult = await unconfiguredIdentityProvider.executeAction('rotate', {});
  assert(!providerResult.success, 'Unknown provider fails closed');

  const lifecycleRequest = { ...getGoodRequest(), policyInput: { ...goodPolicy, effect: 'ALLOW' as const, conditions: {} }, permissionInput: { ...goodPermission, action: 'read', privilegeLevel: 'LOW' as const }, privilegeRiskInput: { wildcardPermissions: false, adminPermissions: false, crossEnvironmentAccess: false, productionAccess: false, lowTrustIdentity: false, dormantPrivilegedIdentity: false, privilegeEscalationPath: false } };
  const result = await orchestrateIdentityAccess(lifecycleRequest);
  assert(result.status === 'COMPLETED', 'Full approved identity lifecycle orchestration');
  const repeat = await orchestrateIdentityAccess(lifecycleRequest);
  assert(repeat.identity.idempotencyKey === result.identity.idempotencyKey, 'Repeated identical identity request remains idempotent');

  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz', credential: 'cred123' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API-key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization-header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');
  assert(!JSON.stringify(redacted).includes('cred123'), 'Credential redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 34: FAIL'); process.exit(1); }
  else { console.log('PHASE 34: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
