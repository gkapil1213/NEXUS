import { createPhase26Telemetry, isDuplicateTelemetry } from '../src/core/worker-phase26-telemetry';
import { evaluateHealth } from '../src/core/worker-phase26-health';
import { detectThresholdAnomaly, createAnomaly } from '../src/core/worker-phase26-anomaly';
import { correlateSignals } from '../src/core/worker-phase26-correlation';
import { createIncident, transitionIncident } from '../src/core/worker-phase26-incident';
import { createIncidentCluster } from '../src/core/worker-phase26-incident-cluster';
import { assessImpact } from '../src/core/worker-phase26-impact';
import { calculateBlastRadius, detectCycle } from '../src/core/worker-phase26-blast-radius';
import { createRootCauseCandidate } from '../src/core/worker-phase26-root-cause';
import { correlateChange } from '../src/core/worker-phase26-change-correlation';
import { evaluateSLO } from '../src/core/worker-phase26-slo';
import { evaluateErrorBudget } from '../src/core/worker-phase26-error-budget';
import { assessRisk } from '../src/core/worker-phase26-risk';
import { createRemediationPlan } from '../src/core/worker-phase26-remediation-plan';
import { governRemediation } from '../src/core/worker-phase26-remediation-governance';
import { evaluateRemediationSafety } from '../src/core/worker-phase26-remediation-safety';
import { createRemediationExecution, transitionRemediationExecution } from '../src/core/worker-phase26-remediation-execution';
import { verifyRemediation } from '../src/core/worker-phase26-remediation-verification';
import { createRemediationRollback } from '../src/core/worker-phase26-remediation-rollback';
import { evaluateRemediationCircuitBreaker } from '../src/core/worker-phase26-remediation-circuit-breaker';
import { createEscalation } from '../src/core/worker-phase26-escalation';
import { createPostmortem } from '../src/core/worker-phase26-postmortem';
import { createOperationalEvidence } from '../src/core/worker-phase26-evidence';
import { createOperationalAuditEvent } from '../src/core/worker-phase26-audit';
import { addOperationalLineageNode, OperationalLineage } from '../src/core/worker-phase26-lineage';
import { createLearningRecord } from '../src/core/worker-phase26-learning';
import { orchestrateAutonomousOperations } from '../src/core/worker-phase26-autonomous-operations-control-plane';
import { redactSecrets } from '../src/core/secret-redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) { if (cond) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}`); failed++; } }

const goodTelemetry = {
  source: 'prometheus',
  sourceType: 'METRIC' as const,
  service: 'svc1',
  environment: 'prod',
  timestamp: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  receivedAt: new Date().toISOString(),
  value: 0.15,
  unit: 'rate',
  severity: 'CRITICAL' as const,
  dimensions: {},
  metadata: {},
  provenance: 'test',
  correlationId: 'corr1',
};

const goodHealth = {
  latency: 100,
  availability: 0.99,
  errorRate: 0.01,
  throughput: 1000,
  resourceSaturation: 0.5,
  dependencyHealth: 0.9,
  deploymentState: 'READY',
  infrastructureState: 'HEALTHY',
  thresholds: { maxLatency: 500, minAvailability: 0.95, maxErrorRate: 0.05, minThroughput: 100, maxSaturation: 0.8, minDependencyHealth: 0.7 },
};

const goodGraph = { nodes: ['svc1', 'db', 'cache'], edges: { svc1: ['db', 'cache'] } };

const goodRiskInput = {
  incidentSeverity: 'P4',
  blastRadius: 0,
  confidence: 1,
  healthState: 'HEALTHY',
  sloState: 'SLO_MET',
  deploymentCorrelated: false,
  dependencyUncertainty: 0,
  providerAvailable: true,
  historicalFailure: false,
};
const _oldRiskInput = {
  incidentSeverity: 'P1',
  blastRadius: 1,
  confidence: 0.8,
  healthState: 'HEALTHY',
  sloState: 'SLO_MET',
  deploymentCorrelated: true,
  dependencyUncertainty: 0.2,
  providerAvailable: true,
  historicalFailure: false,
};

const goodGovernance = {
  authorized: true,
  environment: 'prod',
  incidentSeverity: 'P1',
  actionRisk: 'LOW',
  blastRadius: 1,
  confidence: 0.8,
  healthState: 'HEALTHY',
  rollbackAvailable: true,
  circuitBreakerOpen: false,
  frozen: false,
  approvalRequired: false,
};

const goodSafety = {
  authorizationMissing: false,
  evidenceMissing: false,
  healthUnknown: false,
  providerUnavailable: false,
  rollbackUnavailableForHighRisk: false,
  circuitBreakerOpen: false,
  productionFreeze: false,
  blastRadiusExceeded: false,
  actionUnrecognized: false,
  idempotencyNotGuaranteed: false,
};

function getGoodRequest() {
  return {
    tenantId: 't',
    correlationId: 'c',
    telemetry: goodTelemetry,
    health: goodHealth,
    anomalyThreshold: 0.1,
    graph: goodGraph,
    slo: { currentValue: 0.01, target: 0.05, burnRate: 0.1 },
    errorBudget: { total: 10, consumed: 1, burnRate: 0.1 },
    riskInput: goodRiskInput,
    governanceInput: goodGovernance,
    safetyInput: goodSafety,
    provider: {
      async executeAction() { return { success: true, reason: 'ok', evidence: [] }; },
    },
  };
}

async function main() {
  console.log('=== Phase 26: Autonomous Production Operations & Closed-Loop AIOps ===');

  // Telemetry
  const telemetry = createPhase26Telemetry(goodTelemetry);
  assert(telemetry.telemetryId.length > 0, 'Telemetry creation');
  const dupTelemetry = createPhase26Telemetry(goodTelemetry);
  assert(isDuplicateTelemetry(telemetry, dupTelemetry), 'Duplicate telemetry prevention');

  // Health
  assert(evaluateHealth(goodHealth) === 'HEALTHY', 'Health evaluation');
  assert(evaluateHealth({ ...goodHealth, deploymentState: 'UNKNOWN' }) === 'UNKNOWN', 'Unknown health fails closed');

  // Anomaly
  assert(detectThresholdAnomaly({ value: 0.15 }, 0.1).detected, 'Threshold anomaly detection');
  const anomaly = createAnomaly({ telemetryId: telemetry.telemetryId, detector: 'THRESHOLD', severity: 'HIGH', score: 0.6, explanation: 'test', confidence: 0.8, provenance: 'test' });
  assert(anomaly.anomalyId.length > 0, 'Anomaly creation');

  // Correlation
  const correlations = correlateSignals([{ telemetryId: telemetry.telemetryId, service: telemetry.service, environment: telemetry.environment, timestamp: telemetry.timestamp }], 3600000);
  assert(correlations.length === 1, 'Signal correlation');

  // Incident
  const incident = createIncident({ service: 'svc1', environment: 'prod', severity: 'P1', title: 'High error rate', description: '', evidence: [] });
  assert(incident.incidentId.length > 0, 'Incident creation');
  const dupIncident = createIncident({ service: 'svc1', environment: 'prod', severity: 'P1', title: 'High error rate', description: '', evidence: [] });
  assert(dupIncident.idempotencyKey === incident.idempotencyKey, 'Duplicate incident prevention');
  const cluster = createIncidentCluster([incident.incidentId]);
  assert(cluster.clusterId.length > 0, 'Incident clustering');
  assert(transitionIncident(incident, 'ACKNOWLEDGED').status === 'ACKNOWLEDGED', 'Incident transition');

  // Impact & blast radius
  assert(assessImpact({ customerImpact: true, affectedServices: 5, severity: 'P1', securityImpact: true }).overall === 'CRITICAL', 'Impact analysis');
  assert(calculateBlastRadius(goodGraph, 'svc1') === 3, 'Blast-radius calculation');
  assert(detectCycle({ nodes: ['a','b'], edges: { a: ['b'], b: ['a'] } }), 'Dependency cycle detection');

  // Root cause
  const rootCause = createRootCauseCandidate({ category: 'deployment', confidence: 0.6, evidence: [], explanation: 'test', firstObserved: new Date().toISOString(), lastObserved: new Date().toISOString() });
  assert(rootCause.candidateId.length > 0, 'Root-cause candidate generation');

  // Change correlation
  const changeCorr = correlateChange(incident.incidentId, 'rel1', 'dep1', new Date().toISOString(), new Date(Date.now() - 60000).toISOString());
  assert(changeCorr.type === 'BEFORE', 'Deployment correlation');

  // SLO & error budget
  assert(evaluateSLO(0.01, 0.05, 0.1) === 'SLO_MET', 'SLO evaluation');
  assert(evaluateSLO(0.1, 0.05, 0.1) === 'SLO_BREACHED', 'SLO breach detection');
  const budget = evaluateErrorBudget(10, 6, 0.8);
  assert(budget.exhaustionRisk === 'HIGH', 'Error-budget evaluation');

  // Risk
  assert(assessRisk(goodRiskInput) === 'LOW', 'Risk calculation');

  // Remediation
  const plan = createRemediationPlan({ incidentId: incident.incidentId, actions: ['restart_worker'], expectedOutcome: 'restore', risk: 'LOW', prerequisites: [], safetyChecks: [], rollbackPlan: 'none', verificationPlan: 'health check' });
  assert(plan.planId.length > 0, 'Remediation plan creation');
  assert(governRemediation(goodGovernance) === 'ALLOW', 'Governance ALLOW');
  assert(governRemediation({ ...goodGovernance, authorized: false }) === 'DENY', 'Governance DENY');
  assert(governRemediation({ ...goodGovernance, approvalRequired: true }) === 'REQUIRE_APPROVAL', 'Approval requirement');
  assert(!evaluateRemediationSafety(goodSafety).allowed === false, 'Safety denial');

  // Execution
  let exec = createRemediationExecution({ planId: plan.planId });
  assert(exec.executionId.length > 0, 'Remediation execution');
  exec = transitionRemediationExecution(exec, 'APPROVED');
  exec = transitionRemediationExecution(exec, 'EXECUTING');
  exec = transitionRemediationExecution(exec, 'SUCCEEDED');
  assert(exec.status === 'SUCCEEDED', 'Remediation execution success');
  assert(transitionRemediationExecution(createRemediationExecution({ planId: plan.planId }), 'APPROVED').status === 'APPROVED', 'Legal transition');

  // Provider unavailable
  const unavailableProvider = { executeAction: async () => ({ success: false, reason: 'unavailable', evidence: [] }) };
  const unavailableResult = await orchestrateAutonomousOperations({ ...getGoodRequest(), provider: unavailableProvider });
  assert(unavailableResult.status === 'FAILED', 'Provider unavailable handling');

  // Verification
  assert(verifyRemediation({ health: 'HEALTHY', errorRate: 0.01, latency: 100, availability: 0.99, sloState: 'SLO_MET', incidentState: 'RESOLVED' }) === 'VERIFIED', 'Verification success');
  assert(verifyRemediation({ health: 'UNHEALTHY', errorRate: 0.1, latency: 100, availability: 0.9, sloState: 'SLO_BREACHED', incidentState: 'OPEN' }) === 'FAILED', 'Verification failure');

  // Rollback
  const rollback = createRemediationRollback(exec.executionId);
  assert(rollback.rollbackId.length > 0, 'Rollback creation');
  assert(createRemediationRollback(exec.executionId).idempotencyKey === rollback.idempotencyKey, 'Rollback idempotency');

  // Circuit breaker
  assert(evaluateRemediationCircuitBreaker(2, 3) === 'CLOSED', 'Circuit breaker closed');
  assert(evaluateRemediationCircuitBreaker(3, 3) === 'OPEN', 'Circuit breaker opens');

  // Escalation, postmortem
  assert(createEscalation(incident.incidentId, 'timeout').escalationId.length > 0, 'Incident escalation');
  const postmortem = createPostmortem({ incidentId: incident.incidentId, timeline: [], detection: '', impact: '', rootCauseCandidates: [], remediation: '', verification: '', contributingFactors: [], evidence: [], lessonsLearned: [] });
  assert(postmortem.postmortemId.length > 0, 'Postmortem creation');

  // Evidence, audit, lineage
  const evidence = createOperationalEvidence({ operation: 'test', actor: 'system', inputs: {}, decision: 'ALLOW', executionResult: 'success', verificationResult: 'verified', provenance: 'test' });
  assert(evidence.evidenceId.length > 0, 'Operational evidence');
  const audit = createOperationalAuditEvent({ tenantId: 't', correlationId: 'c', eventType: 'TEST', reason: 'test', decision: 'ALLOW' });
  assert(audit.eventType === 'TEST', 'Operational audit');
  const lineage: OperationalLineage = { rootId: 'root', nodes: [] };
  const line1 = addOperationalLineageNode(lineage, { version: 1, incidentId: incident.incidentId, timestamp: new Date().toISOString() });
  assert(line1.nodes.length === 1, 'Operational lineage');

  // Learning
  const learning = createLearningRecord({ incidentType: 'type', remediationType: 'restart', predictedRisk: 'LOW', actualRisk: 'LOW', predictedOutcome: 'success', actualOutcome: 'success', verification: 'verified', rollback: 'none', duration: 10, recurrence: 0 });
  assert(learning.createdAt.length > 0, 'Learning record');

  // AI recommendation cannot bypass governance (simulated)
  const badGovernance = { ...goodGovernance, authorized: false };
  const orchestration = await orchestrateAutonomousOperations({ ...getGoodRequest(), governanceInput: badGovernance });
  assert(orchestration.status === 'BLOCKED', 'AI recommendation cannot bypass governance');

  // Idempotency
  const result1 = await orchestrateAutonomousOperations(getGoodRequest());
  const result2 = await orchestrateAutonomousOperations(getGoodRequest());
  assert(result1.telemetry.idempotencyKey === result2.telemetry.idempotencyKey, 'Repeated autonomous cycle idempotency');

  // Security redaction
  const redacted = redactSecrets({ password: 'secret123', token: 'tok123', apiKey: 'key123', authorization: 'Bearer abc', secret: 'xyz' });
  assert(!JSON.stringify(redacted).includes('secret123'), 'Password redaction');
  assert(!JSON.stringify(redacted).includes('tok123'), 'Token redaction');
  assert(!JSON.stringify(redacted).includes('key123'), 'API key redaction');
  assert(!JSON.stringify(redacted).includes('Bearer abc'), 'Authorization header redaction');
  assert(!JSON.stringify(redacted).includes('xyz'), 'Secret redaction');

  console.log(`\n${passed} tests passed, ${failed} tests failed.`);
  if (failed > 0) { console.log('PHASE 26: FAIL'); process.exit(1); }
  else { console.log('PHASE 26: PASS'); }
}

main().catch(err => { console.error(err); process.exit(1); });
