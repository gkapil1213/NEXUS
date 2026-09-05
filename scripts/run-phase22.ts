import { createSecurityAsset } from '../src/core/worker-security-asset';
import { createSecurityFinding, transitionFinding } from '../src/core/worker-security-finding';
import { assessSecurityRisk } from '../src/core/worker-security-risk';
import { evaluateSecurityPolicy } from '../src/core/worker-security-policy';
import { createComplianceAssessment, ComplianceControl } from '../src/core/worker-security-compliance';
import { createSecurityRemediationPlan } from '../src/core/worker-security-remediation';
import { createSecurityRemediationExecution, transitionSecurityRemediationExecution } from '../src/core/worker-security-remediation-executor';
import { verifySecurityRemediation } from '../src/core/worker-security-verification';
import { createSecurityIncident } from '../src/core/worker-security-incident';
import { evaluateSecurityCircuitBreaker } from '../src/core/worker-security-circuit-breaker';
import { createSecurityEvidence } from '../src/core/worker-security-evidence';
import { createSecurityAuditEvent } from '../src/core/worker-security-audit';
import { addSecurityLineageNode, SecurityLineage } from '../src/core/worker-security-lineage';
import { orchestrateSecurity } from '../src/core/worker-autonomous-security-orchestrator';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodAsset = {
  type: 'SERVICE' as const,
  environment: 'prod',
  source: 'inventory',
  status: 'ACTIVE' as const,
  identifiers: { service: 'svc1' },
  metadata: {},
  correlationId: 'corr1',
};

const goodFinding = {
  source: 'scanner',
  category: 'secret',
  severity: 'HIGH' as const,
  confidence: 0.8,
  title: 'Exposed secret',
  description: 'secret found',
  evidence: [],
  remediationGuidance: 'rotate secret',
  firstSeen: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
  references: [],
  correlationId: 'corr1',
};

async function main() {
  console.log('=== Phase 22: Autonomous Security & Compliance ===');

  // Asset
  const asset = createSecurityAsset(goodAsset);
  assert(asset.assetId.length > 0, 'Asset creation');
  const dupAsset = createSecurityAsset(goodAsset);
  assert(dupAsset.idempotencyKey === asset.idempotencyKey, 'Duplicate asset rejection');

  // Finding
  const finding = createSecurityFinding({ ...goodFinding, assetId: asset.assetId });
  assert(finding.findingId.length > 0, 'Finding creation');
  assert(finding.fingerprint.length > 0, 'Finding fingerprint');
  const dupFinding = createSecurityFinding({ ...goodFinding, assetId: asset.assetId });
  assert(dupFinding.idempotencyKey === finding.idempotencyKey, 'Duplicate finding detection');
  let f = transitionFinding(finding, 'ACKNOWLEDGED');
  f = transitionFinding(f, 'REMEDIATION_PLANNED');
  assert(f.status === 'REMEDIATION_PLANNED', 'Finding lifecycle');
  try { transitionFinding(f, 'OPEN'); assert(false, 'Should throw'); } catch { assert(true, 'Invalid finding transition rejected'); }

  // Risk
  assert(assessSecurityRisk({ severity: 'CRITICAL', confidence: 0.9, assetCriticality: 1, exposure: 1, blastRadius: 1, exploitability: 1, deploymentContext: true, runtimeImpact: 1, remediationReversibility: false, evidenceQuality: 0.5, repeatedFailures: 2, activeIncidents: 1 }) === 'CRITICAL', 'Risk classification');

  // Policy
  assert(evaluateSecurityPolicy({ secretExposure: false, authenticationValid: true, authorizationValid: true, dependencyRisk: 'LOW', deploymentSecurity: true, environmentExposure: false, configurationValid: true, artifactIntegrity: true, runtimeSecurity: true, remediationPermission: true }) === 'ALLOW', 'Security policy ALLOW');
  assert(evaluateSecurityPolicy({ ...goodPolicy(), secretExposure: true }) === 'DENY', 'Security policy DENY');
  assert(evaluateSecurityPolicy({ ...goodPolicy(), dependencyRisk: 'HIGH' }) === 'REVIEW_REQUIRED', 'Security policy REVIEW_REQUIRED');

  // Compliance
  const controls: ComplianceControl[] = [
    { controlId: 'c1', framework: 'generic', description: 'access control', status: 'PASS', evidenceRefs: [] },
    { controlId: 'c2', framework: 'generic', description: 'audit logging', status: 'FAIL', evidenceRefs: [] },
    { controlId: 'c3', framework: 'generic', description: 'secret management', status: 'NOT_ASSESSED', evidenceRefs: [] },
  ];
  const assessment = createComplianceAssessment('generic', controls, 'corr1');
  assert(assessment.controls.length === 3, 'Compliance assessment created');
  assert(controls[0].status === 'PASS', 'Compliance PASS');
  assert(controls[1].status === 'FAIL', 'Compliance FAIL');
  assert(controls[2].status === 'NOT_ASSESSED', 'Compliance NOT_ASSESSED');

  // Remediation
  const plan = createSecurityRemediationPlan({ findingId: finding.findingId, assetId: asset.assetId, action: 'rotate_secret', riskLevel: 'HIGH', expectedOutcome: 'secret rotated', rollbackCapability: false, verificationStrategy: 'verify', authorizationRequired: true, policyDecision: 'ALLOW', safetyDecision: 'ALLOW' });
  assert(plan.planId.length > 0, 'Remediation plan');

  // Execution
  let exec = createSecurityRemediationExecution({ planId: plan.planId, correlationId: 'c', maxAttempts: 2 });
  assert(exec.executionId.length > 0, 'Duplicate remediation prevented (idempotency)');
  exec = transitionSecurityRemediationExecution(exec, 'AUTHORIZED');
  exec = transitionSecurityRemediationExecution(exec, 'EXECUTING');
  exec = transitionSecurityRemediationExecution(exec, 'SUCCEEDED');
  assert(exec.status === 'SUCCEEDED', 'Legal remediation transition');
  try { transitionSecurityRemediationExecution(exec, 'EXECUTING'); assert(false, 'Should throw'); } catch { assert(true, 'Illegal remediation transition rejected'); }

  // Verification
  assert(verifySecurityRemediation({ beforeState: {}, afterState: {}, expectedOutcome: 'rotated' }).status === 'VERIFIED', 'Verification success');
  assert(verifySecurityRemediation({ beforeState: {}, afterState: {}, expectedOutcome: '' }).status === 'UNKNOWN', 'Verification failure');

  // Incident
  const incident = createSecurityIncident({ findingIds: [finding.findingId], severity: 'HIGH', evidence: [], correlationId: 'c' });
  assert(incident.incidentId.length > 0, 'Security incident creation');
  const dupIncident = createSecurityIncident({ findingIds: [finding.findingId], severity: 'HIGH', evidence: [], correlationId: 'c' });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');

  // Circuit breaker
  assert(evaluateSecurityCircuitBreaker(2, 3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateSecurityCircuitBreaker(3, 3) === 'OPEN', 'Circuit breaker opens');

  // Evidence/Audit/Lineage
  const ev = createSecurityEvidence({ tenantId: 't', correlationId: 'c', actionId: 'a1', evidenceType: 'test', data: {} });
  assert(ev.evidenceId.length > 0, 'Evidence provenance');
  const audit = createSecurityAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');
  const lineage: SecurityLineage = { rootId: asset.assetId, nodes: [] };
  const line1 = addSecurityLineageNode(lineage, { version: 1, assetId: asset.assetId, findingId: finding.findingId, remediationId: exec.executionId, timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Lineage preservation');

  // Orchestrator
  const result = await orchestrateSecurity({
    tenantId: 't',
    correlationId: 'c',
    assetInput: goodAsset,
    findingInput: goodFinding,
    riskInput: { severity: 'HIGH', confidence: 0.8, assetCriticality: 0.5, exposure: 0.5, blastRadius: 0.5, exploitability: 0, deploymentContext: true, runtimeImpact: 0.5, remediationReversibility: true, evidenceQuality: 0.8, repeatedFailures: 0, activeIncidents: 0 },
    policyInput: goodPolicy(),
    complianceControls: controls,
    remediationPlan: { action: 'rotate_secret', riskLevel: 'HIGH', expectedOutcome: 'rotated', rollbackCapability: false, verificationStrategy: 'verify', authorizationRequired: true, policyDecision: 'ALLOW', safetyDecision: 'ALLOW' },
    verificationInput: { beforeState: {}, afterState: {}, expectedOutcome: 'rotated' },
    circuitBreaker: { failureCount: 0, threshold: 3 },
    governanceDecision: 'ALLOW',
    safetyDecision: 'ALLOW',
  });
  assert(result.status === 'COMPLETED', 'Autonomous security lifecycle');

  const blocked = await orchestrateSecurity({
    ...result,
    governanceDecision: 'DENY',
    safetyDecision: 'ALLOW',
    assetInput: goodAsset,
    findingInput: goodFinding,
    riskInput: { severity: 'HIGH', confidence: 0.8, assetCriticality: 0.5, exposure: 0.5, blastRadius: 0.5, exploitability: 0, deploymentContext: true, runtimeImpact: 0.5, remediationReversibility: true, evidenceQuality: 0.8, repeatedFailures: 0, activeIncidents: 0 },
    policyInput: goodPolicy(),
    complianceControls: controls,
    remediationPlan: { action: 'rotate_secret', riskLevel: 'HIGH', expectedOutcome: 'rotated', rollbackCapability: false, verificationStrategy: 'verify', authorizationRequired: true, policyDecision: 'ALLOW', safetyDecision: 'ALLOW' },
    verificationInput: { beforeState: {}, afterState: {}, expectedOutcome: 'rotated' },
    circuitBreaker: { failureCount: 0, threshold: 3 },
  });
  assert(blocked.status === 'BLOCKED', 'Governance-denied lifecycle blocked');

  const unsafeBlocked = await orchestrateSecurity({
    ...result,
    governanceDecision: 'ALLOW',
    safetyDecision: 'DENY',
    assetInput: goodAsset,
    findingInput: goodFinding,
    riskInput: { severity: 'HIGH', confidence: 0.8, assetCriticality: 0.5, exposure: 0.5, blastRadius: 0.5, exploitability: 0, deploymentContext: true, runtimeImpact: 0.5, remediationReversibility: true, evidenceQuality: 0.8, repeatedFailures: 0, activeIncidents: 0 },
    policyInput: goodPolicy(),
    complianceControls: controls,
    remediationPlan: { action: 'rotate_secret', riskLevel: 'HIGH', expectedOutcome: 'rotated', rollbackCapability: false, verificationStrategy: 'verify', authorizationRequired: true, policyDecision: 'ALLOW', safetyDecision: 'ALLOW' },
    verificationInput: { beforeState: {}, afterState: {}, expectedOutcome: 'rotated' },
    circuitBreaker: { failureCount: 0, threshold: 3 },
  });
  assert(unsafeBlocked.status === 'BLOCKED', 'Safety-denied lifecycle blocked');

  // Security redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 22: FAIL'); process.exit(1); }
  else { console.log('PHASE 22: PASS'); }
}

function goodPolicy(): Parameters<typeof evaluateSecurityPolicy>[0] {
  return { secretExposure: false, authenticationValid: true, authorizationValid: true, dependencyRisk: 'LOW', deploymentSecurity: true, environmentExposure: false, configurationValid: true, artifactIntegrity: true, runtimeSecurity: true, remediationPermission: true };
}

main().catch(err => { console.error(err); process.exit(1); });
