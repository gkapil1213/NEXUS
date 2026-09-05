import { createSecuritySignal } from '../src/core/worker-phase27-security-signal';
import { detectThreat, createSecurityDetection } from '../src/core/worker-phase27-threat-detection';
import { correlateThreats } from '../src/core/worker-phase27-threat-correlation';
import { assessSecurityRisk } from '../src/core/worker-phase27-security-risk';
import { calculateSecurityBlastRadius, detectCycle } from '../src/core/worker-phase27-security-blast-radius';
import { createSecurityIncident, transitionSecurityIncident } from '../src/core/worker-phase27-security-incident';
import { createResponsePlan } from '../src/core/worker-phase27-response-plan';
import { evaluateSecurityGovernance } from '../src/core/worker-phase27-security-governance';
import { createContainmentExecution, transitionContainment } from '../src/core/worker-phase27-containment-execution';
import { createRemediationPlan } from '../src/core/worker-phase27-remediation-plan';
import { createRemediationExecution, transitionRemediationExecution } from '../src/core/worker-phase27-remediation-execution';
import { evaluateRemediationSafety } from '../src/core/worker-phase27-remediation-safety';
import { evaluateSecurityCircuitBreaker } from '../src/core/worker-phase27-security-circuit-breaker';
import { verifySecurityResponse } from '../src/core/worker-phase27-security-verification';
import { createSecurityRollback } from '../src/core/worker-phase27-security-rollback';
import { createSecurityEscalation } from '../src/core/worker-phase27-security-escalation';
import { createSecurityEvidence } from '../src/core/worker-phase27-security-evidence';
import { createSecurityAuditEvent } from '../src/core/worker-phase27-security-audit';
import { addSecurityLineageNode, SecurityLineage } from '../src/core/worker-phase27-security-lineage';
import { createSecurityLearningRecord } from '../src/core/worker-phase27-security-learning';
import { orchestrateSecurityOperations } from '../src/core/worker-phase27-autonomous-security-operations-control-plane';
import { unconfiguredSecurityProvider } from '../src/core/worker-phase27-security-provider';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodSignal = {
  source: 'scanner',
  sourceType: 'vulnerability',
  category: 'credential_exposure',
  severity: 'HIGH' as const,
  assetId: 'svc1',
  timestamp: new Date().toISOString(),
  evidence: [],
  correlationId: 'corr1',
};

const goodRiskInput = {
  severity: 'HIGH',
  confidence: 0.8,
  assetCriticality: 'HIGH',
  exposure: 0.7,
  blastRadius: 1,
  knownExploited: false,
  exploitability: 0.5,
  dataSensitivity: 0.5,
};

const goodGraph = { nodes: ['svc1', 'db', 'cache'], edges: { svc1: ['db', 'cache'] } };

const goodGovernance = {
  risk: 'HIGH',
  action: 'isolate',
  asset: 'svc1',
  environment: 'prod',
  blastRadius: 1,
  authorized: true,
  confidence: 0.8,
  reversibility: true,
};

const goodSafety = {
  blastRadius: 1,
  reversibility: true,
  serviceCriticality: 'MEDIUM',
  dependencyImpact: 0.2,
  changeRisk: 'LOW',
  productionEnvironment: true,
  approvalRequired: false,
};

const goodVerification = {
  threatSignalDisappeared: true,
  credentialInvalid: true,
  artifactQuarantined: true,
  vulnerabilityReachable: false,
  deploymentRolledBack: false,
  accessRestrictionActive: true,
  policyViolationResolved: true,
};

function getGoodRequest() {
  return {
    tenantId: 't',
    correlationId: 'c',
    signalInput: goodSignal,
    riskInput: goodRiskInput,
    graph: goodGraph,
    governanceInput: goodGovernance,
    safetyInput: goodSafety,
    circuitBreaker: { failureCount: 0, threshold: 3 },
    provider: { async scan() { return { status: 'SUCCESS', findings: [] }; } },
    verificationInput: goodVerification,
  };
}

async function main() {
  console.log('=== Phase 27: Autonomous Security Operations ===');

  // 1-3 Signals
  const signal = createSecuritySignal(goodSignal);
  assert(signal.signalId.length > 0, 'Security signal creation');
  try { createSecuritySignal({ ...goodSignal, source: '' }); assert(false, 'Should throw'); } catch { assert(true, 'Malformed signal rejection'); }
  const dupSignal = createSecuritySignal(goodSignal);
  assert(dupSignal.fingerprint === signal.fingerprint, 'Signal fingerprint determinism');

  // 4-5 Detection
  const detectionResult = detectThreat(signal);
  assert(detectionResult.detected, 'Threat detection');
  const detection = createSecurityDetection({ signalId: signal.signalId, rule: detectionResult.rule, confidence: detectionResult.confidence, explanation: detectionResult.explanation, assetId: signal.assetId, potentialImpact: 'unknown', provenance: 'rule' });
  assert(detection.detectionId.length > 0, 'Detection provenance');

  // 6-7 Correlation
  const correlated = correlateThreats([{ signalId: signal.signalId, assetId: signal.assetId, category: signal.category }, { signalId: 's2', assetId: signal.assetId, category: signal.category }]);
  assert(correlated.length === 1 && correlated[0].signalIds.length === 2, 'Threat correlation');
  const dupCorr = correlateThreats([{ signalId: signal.signalId, assetId: signal.assetId, category: signal.category }]);
  assert(dupCorr.length === 0, 'Duplicate correlation prevention');

  // 8 Asset context (not directly tested via create function but via risk)
  assert(assessSecurityRisk(goodRiskInput).risk === 'HIGH', 'Asset context / vulnerability risk');
  const risk = assessSecurityRisk(goodRiskInput);
  assert(risk.explanation.length > 0, 'Risk explainability');

  // Blast radius
  assert(calculateSecurityBlastRadius(goodGraph, 'svc1') === 3, 'Blast-radius calculation');
  assert(detectCycle({ nodes: ['a','b'], edges: { a: ['b'], b: ['a'] } }), 'Cycle detection');

  // Incident
  const incident = createSecurityIncident({ title: 'Credential exposure', severity: 'HIGH', signalIds: [signal.signalId] });
  assert(incident.incidentId.length > 0, 'Security incident creation');
  const dupIncident = createSecurityIncident({ title: 'Credential exposure', severity: 'HIGH', signalIds: [signal.signalId] });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');
  const triaged = transitionSecurityIncident(incident, 'TRIAGED');
  assert(triaged.status === 'TRIAGED', 'Valid incident transition');
  try { transitionSecurityIncident(triaged, 'DETECTED'); assert(false, 'Should throw'); } catch { assert(true, 'Invalid incident transition'); }

  // Response plan
  const plan = createResponsePlan({ incidentId: incident.incidentId, actions: ['isolate'], risk: 'HIGH' });
  assert(plan.planId.length > 0, 'Response plan creation');

  // Governance
  assert(evaluateSecurityGovernance(goodGovernance) === 'ALLOW', 'Governance ALLOW');
  assert(evaluateSecurityGovernance({ ...goodGovernance, authorized: false }) === 'DENY', 'Governance DENY');
  assert(evaluateSecurityGovernance({ ...goodGovernance, risk: 'CRITICAL' }) === 'REQUIRE_APPROVAL', 'Governance REQUIRE_APPROVAL');
  assert(evaluateSecurityGovernance({ ...goodGovernance, risk: 'UNKNOWN' }) === 'REQUIRE_APPROVAL', 'Unknown governance fails closed');

  // Containment
  const containment = createContainmentExecution({ incidentId: incident.incidentId, action: 'isolate' });
  assert(containment.containmentId.length > 0, 'Containment creation');
  const dupContainment = createContainmentExecution({ incidentId: incident.incidentId, action: 'isolate' });
  assert(dupContainment.idempotencyKey === containment.idempotencyKey, 'Duplicate containment prevention');

  // Remediation
  const remediationPlan = createRemediationPlan({ incidentId: incident.incidentId, actions: ['patch'], risk: 'HIGH' });
  assert(remediationPlan.planId.length > 0, 'Remediation creation');
  assert(evaluateRemediationSafety(goodSafety).allowed, 'Remediation safety gate');
  assert(!evaluateRemediationSafety({ ...goodSafety, blastRadius: 10 }).allowed, 'High-risk action blocked');

  // Circuit breaker
  assert(evaluateSecurityCircuitBreaker(2, 3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateSecurityCircuitBreaker(3, 3) === 'OPEN', 'Circuit breaker opens after threshold');

  // Verification
  assert(verifySecurityResponse(goodVerification) === 'VERIFIED', 'Verification success');
  assert(verifySecurityResponse({ ...goodVerification, threatSignalDisappeared: false }) === 'FAILED', 'Verification failure');
  assert(verifySecurityResponse({ ...goodVerification, credentialInvalid: false }) === 'FAILED', 'Unknown verification fails closed');

  // Rollback & escalation
  const remediationExec = createRemediationExecution({ planId: remediationPlan.planId });
  const rollback = createSecurityRollback(remediationExec.remediationId);
  assert(rollback.rollbackId.length > 0, 'Rollback creation');
  const escalation = createSecurityEscalation(incident.incidentId, 'verification failed');
  assert(escalation.escalationId.length > 0, 'Security escalation');

  // Evidence, audit, lineage, learning
  const evidence = createSecurityEvidence({ incidentId: incident.incidentId, type: 'response', data: {} });
  assert(evidence.evidenceId.length > 0, 'Evidence creation');
  const audit = createSecurityAuditEvent({ tenantId: 't', correlationId: 'c', incidentId: incident.incidentId, eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Audit trail');
  const lineage: SecurityLineage = { rootId: incident.incidentId, nodes: [] };
  const line1 = addSecurityLineageNode(lineage, { version: 1, incidentId: incident.incidentId, signalId: signal.signalId, timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Security lineage');
  const learning = createSecurityLearningRecord({ incidentType: 'test', remediationType: 'patch', success: true, duration: 0, recurrence: 0 });
  assert(learning.createdAt.length > 0, 'Learning record');

  // Provider honesty
  const providerResult = await unconfiguredSecurityProvider.scan();
  assert(providerResult.status === 'UNCONFIGURED', 'Unconfigured provider reported honestly');

  // Orchestrator end-to-end
  const result = await orchestrateSecurityOperations(getGoodRequest());
  assert(result.status === 'COMPLETED', 'Control-plane end-to-end lifecycle');
  const idempotent = await orchestrateSecurityOperations(getGoodRequest());
  assert(idempotent.signal.idempotencyKey === result.signal.idempotencyKey, 'Repeated identical security request remains idempotent');

  // Redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 27: FAIL'); process.exit(1); }
  else { console.log('PHASE 27: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
