import { classifyGovernanceRisk } from '../src/core/worker-governance-risk';
import { createGovernancePolicy, evaluatePolicy, transitionPolicy } from '../src/core/worker-governance-policy';
import { createApprovalRequest, approveRequest, isApprovalValid } from '../src/core/worker-approval-request';
import { createEmergencyAuthorization, isEmergencyValid } from '../src/core/worker-governance-emergency';
import { makeGovernanceDecision } from '../src/core/worker-governance-decision';
import { createGovernanceEvidence } from '../src/core/worker-governance-evidence';
import { createGovernanceAuditEvent } from '../src/core/worker-governance-audit';
import { orchestrateGovernance } from '../src/core/worker-autonomous-governance-orchestrator';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodPolicy = {
  name: 'prod-policy',
  version: 1,
  description: 'production policy',
  riskThreshold: 'HIGH' as const,
  autoApproveBelow: 'LOW' as const,
  requireSeparationOfDuties: true,
  minApprovals: 1,
  emergencyAllowed: true,
  correlationId: 'corr1',
};

const goodRequest = {
  tenantId: 'tenantA',
  correlationId: 'corr1',
  action: 'deploy',
  target: 'svc1',
  environment: 'production',
  securitySeverity: 'LOW',
  blastRadius: 0.2,
  reversibility: true,
  previousFailures: 0,
  requesterId: 'user1',
  policy: goodPolicy,
  approvalActor: { actorId: 'approver1', role: 'RELEASE_MANAGER' },
};

async function main() {
  console.log('=== Phase 23: Autonomous Governance, Policy & Human Approval Control Plane ===');

  // Policy
  const policy = createGovernancePolicy({ ...goodPolicy, status: 'DRAFT' });
  assert(policy.policyId.length > 0, 'Policy creation');
  const dupPolicy = createGovernancePolicy({ ...goodPolicy, status: 'DRAFT' });
  assert(dupPolicy.idempotencyKey === policy.idempotencyKey, 'Duplicate policy rejection');
  const activePolicy = transitionPolicy(policy, 'ACTIVE');
  assert(activePolicy.status === 'ACTIVE', 'Policy activation');
  const retiredPolicy = transitionPolicy(activePolicy, 'RETIRED');
  assert(retiredPolicy.status === 'RETIRED', 'Policy retirement');
  try { transitionPolicy(retiredPolicy, 'ACTIVE'); assert(false, 'Should throw'); } catch { assert(true, 'Invalid policy transition rejected'); }

  // Risk
  assert(classifyGovernanceRisk({ action: 'read', target: 'config', environment: 'development', securitySeverity: 'LOW', blastRadius: 0, reversibility: true, previousFailures: 0 }) === 'LOW', 'Low risk');
  assert(classifyGovernanceRisk({ action: 'deploy', target: 'svc1', environment: 'production', securitySeverity: 'MEDIUM', blastRadius: 0.3, reversibility: true, previousFailures: 0 }) === 'MEDIUM', 'Medium risk');
  assert(classifyGovernanceRisk({ action: 'delete', target: 'db', environment: 'production', securitySeverity: 'HIGH', blastRadius: 0.8, reversibility: false, previousFailures: 1 }) === 'CRITICAL', 'Critical risk');
  assert(classifyGovernanceRisk({ action: 'deploy', target: 'svc1', environment: 'production', securitySeverity: 'LOW', blastRadius: 0.2, reversibility: true, previousFailures: 0 }) === 'MEDIUM', 'Deterministic classification');

  // Policy evaluation
  const activePolicy2 = createGovernancePolicy({ ...goodPolicy, status: 'ACTIVE' });
  assert(evaluatePolicy(activePolicy2, 'LOW') === 'ALLOW', 'Policy ALLOW');
  assert(evaluatePolicy(activePolicy2, 'MEDIUM') === 'REQUIRES_APPROVAL', 'Policy REQUIRES_APPROVAL');
  assert(evaluatePolicy(activePolicy2, 'CRITICAL') === 'DENY', 'Policy DENY (risk above threshold)');

  // Approval request
  const approvalReq = createApprovalRequest({
    requestFingerprint: 'req1',
    action: 'deploy',
    target: 'svc1',
    riskLevel: 'MEDIUM',
    policyVersion: activePolicy2.version,
    policyFingerprint: activePolicy2.fingerprint,
    requiredApprovals: 1,
    minApprovers: 1,
    separateDuties: true,
    requesterId: 'user1',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert(approvalReq.approvalRequestId.length > 0, 'Approval request creation');
  const dupApproval = createApprovalRequest({
    requestFingerprint: 'req1',
    action: 'deploy',
    target: 'svc1',
    riskLevel: 'MEDIUM',
    policyVersion: activePolicy2.version,
    policyFingerprint: activePolicy2.fingerprint,
    requiredApprovals: 1,
    minApprovers: 1,
    separateDuties: true,
    requesterId: 'user1',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert(dupApproval.idempotencyKey === approvalReq.idempotencyKey, 'Duplicate approval request rejection');

  // Approval
  const selfApproval = approveRequest(approvalReq, { actorId: 'user1', role: 'RELEASE_MANAGER' }, true);
  assert(!selfApproval.success, 'Self approval rejection');
  const firstApproval = approveRequest(approvalReq, { actorId: 'approver1', role: 'RELEASE_MANAGER' }, true);
  assert(firstApproval.success, 'Authorized approval');
  const duplicateApproval = approveRequest(firstApproval.request, { actorId: 'approver1', role: 'RELEASE_MANAGER' }, true);
  assert(!duplicateApproval.success, 'Duplicate approver rejection');
  // For multi-approval test, create another request with min 2
  const multiReq = createApprovalRequest({
    requestFingerprint: 'req2',
    action: 'delete',
    target: 'db',
    riskLevel: 'HIGH',
    policyVersion: activePolicy2.version,
    policyFingerprint: activePolicy2.fingerprint,
    requiredApprovals: 2,
    minApprovers: 2,
    separateDuties: true,
    requesterId: 'user1',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const firstOfTwo = approveRequest(multiReq, { actorId: 'approver1', role: 'RELEASE_MANAGER' }, true);
  assert(firstOfTwo.success && firstOfTwo.request.status === 'PENDING', 'First approval does not complete quorum');
  const secondOfTwo = approveRequest(firstOfTwo.request, { actorId: 'approver2', role: 'OPERATIONS_ADMIN' }, true);
  assert(secondOfTwo.success && secondOfTwo.request.status === 'APPROVED', 'Approval quorum reached');
  assert(isApprovalValid(secondOfTwo.request), 'Valid approval');

  // Expiration
  const expiredApproval = { ...secondOfTwo.request, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert(!isApprovalValid(expiredApproval), 'Expired approval invalid');

  // Revocation (simulate status change)
  const revokedApproval = { ...secondOfTwo.request, status: 'REVOKED' as const };
  assert(!isApprovalValid(revokedApproval), 'Revoked approval invalid');

  // Emergency
  const emergency = createEmergencyAuthorization({ actorId: 'admin1', role: 'GOVERNANCE_ADMIN', reason: 'critical fix', scope: 'svc1', expiresAt: new Date(Date.now() + 60000).toISOString(), idempotencyKey: 'emergency1' });
  assert(isEmergencyValid(emergency), 'Emergency authorization valid');
  const expiredEmergency = { ...emergency, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert(!isEmergencyValid(expiredEmergency), 'Emergency expiration');

  // Decision
  assert(makeGovernanceDecision({ requestFingerprint: 'r', policy: { status: 'ACTIVE', decision: 'ALLOW' }, riskLevel: 'LOW' }) === 'ALLOW', 'Governance ALLOW');
  assert(makeGovernanceDecision({ requestFingerprint: 'r', policy: { status: 'ACTIVE', decision: 'DENY' }, riskLevel: 'LOW' }) === 'DENY', 'Governance DENY');
  assert(makeGovernanceDecision({ requestFingerprint: 'r', policy: { status: 'ACTIVE', decision: 'REQUIRES_APPROVAL' }, riskLevel: 'MEDIUM', approval: { status: 'PENDING', valid: false } }) === 'REQUIRES_APPROVAL', 'Governance REQUIRES_APPROVAL');

  // Orchestrator
  const result = await orchestrateGovernance(goodRequest);
  assert(result.status === 'COMPLETED', 'Approved lifecycle executes');
  const denied = await orchestrateGovernance({ ...goodRequest, securitySeverity: 'CRITICAL', blastRadius: 0.9, reversibility: false });
  assert(denied.status === 'BLOCKED', 'Governance denial blocks lifecycle');
  const stale = await orchestrateGovernance({ ...goodRequest, approvalActor: undefined });
  assert(stale.status === 'BLOCKED', 'Approval required blocks when missing');

  // Evidence/Audit
  const evidence = createGovernanceEvidence({ requestFingerprint: 'r', policyFingerprint: 'p', policyVersion: 1, riskDecision: 'LOW', approvalState: 'APPROVED', decision: 'ALLOW', reason: 'ok', emergency: false });
  assert(evidence.evidenceId.length > 0, 'Governance evidence created');
  const audit = createGovernanceAuditEvent({ tenantId: 't', correlationId: 'c', requestFingerprint: 'r', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');

  // Idempotency
  const result1 = await orchestrateGovernance(goodRequest);
  const result2 = await orchestrateGovernance(goodRequest);
  assert(result1.decision === result2.decision, 'Repeated identical governance request idempotent');

  // Security redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 23: FAIL'); process.exit(1); }
  else { console.log('PHASE 23: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
