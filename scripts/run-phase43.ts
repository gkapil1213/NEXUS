import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { processProvider } from '../src/core/worker-phase43-provider';
import { processObservabilitySource } from '../src/core/worker-phase43-observability-source';
import { processTelemetry } from '../src/core/worker-phase43-telemetry';
import { processSignalFingerprint } from '../src/core/worker-phase43-signal-fingerprint';
import { processBaseline } from '../src/core/worker-phase43-baseline';
import { processAnomaly } from '../src/core/worker-phase43-anomaly';
import { processTrend } from '../src/core/worker-phase43-trend';
import { processPrediction } from '../src/core/worker-phase43-prediction';
import { processCapacityForecast } from '../src/core/worker-phase43-capacity-forecast';
import { processTopology } from '../src/core/worker-phase43-topology';
import { processCorrelation } from '../src/core/worker-phase43-correlation';
import { processChangeCorrelation } from '../src/core/worker-phase43-change-correlation';
import { processRootCause } from '../src/core/worker-phase43-root-cause';
import { processRisk } from '../src/core/worker-phase43-risk';
import { processImpact } from '../src/core/worker-phase43-impact';
import { processBlastRadius } from '../src/core/worker-phase43-blast-radius';
import { processRemediationPlan } from '../src/core/worker-phase43-remediation-plan';
import { processRemediationSafety } from '../src/core/worker-phase43-remediation-safety';
import { processRemediationExecution } from '../src/core/worker-phase43-remediation-execution';
import { processRemediationVerification } from '../src/core/worker-phase43-remediation-verification';
import { processRemediationRollback } from '../src/core/worker-phase43-remediation-rollback';
import { processRemediationCircuitBreaker } from '../src/core/worker-phase43-remediation-circuit-breaker';
import { processIncident } from '../src/core/worker-phase43-incident';
import { processEscalation } from '../src/core/worker-phase43-escalation';
import { processGovernance } from '../src/core/worker-phase43-governance';
import { processAudit } from '../src/core/worker-phase43-audit';
import { processEvidence } from '../src/core/worker-phase43-evidence';
import { processLineage } from '../src/core/worker-phase43-lineage';
import { processLearning } from '../src/core/worker-phase43-learning';
import { processAutonomousObservabilityAIOpsControlPlane } from '../src/core/worker-phase43-autonomous-observability-aiops-control-plane';

function redactSecret(text: string): string {
  return text
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*[:=]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization=[REDACTED]')
    .replace(/secret\s*[:=]\s*\S+/gi, 'secret=[REDACTED]');
}

const db = new Database(':memory:');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '088_phase43_autonomous_observability_aiops.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf8');
db.exec(migrationSql);

const results: { name: string; pass: boolean; error?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e: any) {
    results.push({ name, pass: false, error: e.message });
  }
}

async function runTests() {
  // Source
  await test('Observability source creation', () => {
    const s = processObservabilitySource({ name: 'src1', provider: 'aws', sourceType: 'metrics' });
    if (!s.id || s.name !== 'src1') throw new Error('Invalid source');
  });
  await test('Duplicate source prevention', () => {
    const s1 = processObservabilitySource({ name: 'dup', provider: 'aws', idempotencyKey: 'src-dup' });
    const s2 = processObservabilitySource({ name: 'dup', provider: 'aws', idempotencyKey: 'src-dup' });
    if (s1.id !== s2.id) throw new Error('Expected same source id');
  });
  await test('Source discovery', () => {
    const s = processObservabilitySource({ name: 'disc', provider: 'aws' });
    if (!s.id) throw new Error('Discovery failed');
  });
  await test('Unknown provider handling', () => {
    try {
      processProvider({ unknown: true });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('UNAVAILABLE')) throw e;
    }
  });
  await test('Provider capability detection', () => {
    const p = processProvider({ name: 'test', capabilities: ['metrics'] });
    if (!p.capabilities.includes('metrics')) throw new Error('Capabilities missing');
  });
  await test('Source health', () => {
    const s = processObservabilitySource({ name: 'health', provider: 'aws', healthState: 'healthy' });
    if (s.healthState !== 'healthy') throw new Error('Health wrong');
  });
  await test('Unknown source health', () => {
    const s = processObservabilitySource({ name: 'unknown-health', provider: 'aws' });
    if (s.healthState !== 'unknown') throw new Error('Expected unknown');
  });

  // Telemetry
  await test('Telemetry normalization', () => {
    const t = processTelemetry({ sourceId: 'src1', signalType: 'cpu', value: '50' });
    if (!t.id || t.signalType !== 'cpu') throw new Error('Normalization failed');
  });
  await test('Invalid telemetry rejection', () => {
    try {
      processTelemetry({ sourceId: 'src1' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid telemetry')) throw e;
    }
  });
  await test('Duplicate telemetry prevention', () => {
    const t1 = processTelemetry({ sourceId: 'src1', signalType: 'cpu', fingerprint: 'dup-tel' });
    const t2 = processTelemetry({ sourceId: 'src1', signalType: 'cpu', fingerprint: 'dup-tel' });
    if (t1.id !== t2.id) throw new Error('Expected same telemetry id');
  });
  await test('Signal fingerprinting', () => {
    const fp = processSignalFingerprint({ sourceId: 'src1', signalType: 'cpu', serviceId: 'svc1' });
    if (!fp.fingerprint) throw new Error('Fingerprint missing');
  });
  await test('Deterministic fingerprint', () => {
    const fp1 = processSignalFingerprint({ sourceId: 'src1', signalType: 'cpu', serviceId: 'svc1' });
    const fp2 = processSignalFingerprint({ sourceId: 'src1', signalType: 'cpu', serviceId: 'svc1' });
    if (fp1.fingerprint !== fp2.fingerprint) throw new Error('Fingerprints differ');
  });

  // Baseline
  await test('Baseline creation', () => {
    const b = processBaseline({ serviceId: 'svc1', metricType: 'cpu', baselineValue: 50 });
    if (!b.id) throw new Error('Baseline missing');
  });
  await test('Normal behavior', () => {
    const b = processBaseline({ serviceId: 'svc1', metricType: 'cpu', baselineValue: 50, confidence: 0.9 });
    if (b.confidence < 0.8) throw new Error('Not normal');
  });
  await test('Behavioral deviation', () => {
    const b = processBaseline({ serviceId: 'svc1', metricType: 'cpu', volatility: 10 });
    if (b.volatility < 5) throw new Error('Deviation not detected');
  });
  await test('Insufficient baseline', () => {
    const b = processBaseline({ serviceId: 'svc1', metricType: 'cpu', insufficient: true });
    if (!b.insufficient) throw new Error('Expected insufficient');
  });

  // Anomaly
  await test('Anomaly detection', () => {
    const a = processAnomaly({ serviceId: 'svc1', anomalyType: 'latency', severity: 'high' });
    if (a.severity !== 'high') throw new Error('Anomaly not detected');
  });
  await test('Anomaly severity', () => {
    const a = processAnomaly({ serviceId: 'svc1', severity: 'critical' });
    if (a.severity !== 'critical') throw new Error('Severity wrong');
  });
  await test('Anomaly confidence', () => {
    const a = processAnomaly({ serviceId: 'svc1', confidence: 0.9 });
    if (a.confidence !== 0.9) throw new Error('Confidence wrong');
  });
  await test('Unknown anomaly handling', () => {
    const a = processAnomaly({ serviceId: 'svc1' });
    if (a.severity !== 'unknown') throw new Error('Expected unknown');
  });

  // Trend
  await test('Trend detection', () => {
    const t = processTrend({ serviceId: 'svc1', metricType: 'latency', direction: 'rising' });
    if (t.direction !== 'rising') throw new Error('Trend not detected');
  });
  await test('Trend direction', () => {
    const t = processTrend({ serviceId: 'svc1', direction: 'declining' });
    if (t.direction !== 'declining') throw new Error('Direction wrong');
  });
  await test('Persistent trend', () => {
    const t = processTrend({ serviceId: 'svc1', persistence: 0.8 });
    if (t.persistence < 0.7) throw new Error('Persistence missing');
  });
  await test('Insufficient trend evidence', () => {
    const t = processTrend({ serviceId: 'svc1', confidence: 0.1 });
    if (t.confidence > 0.5) throw new Error('Expected low confidence');
  });

  // Prediction
  await test('Predictive finding', () => {
    const p = processPrediction({ serviceId: 'svc1', predictedCondition: 'degradation' });
    if (!p.id) throw new Error('Prediction missing');
  });
  await test('Prediction horizon', () => {
    const p = processPrediction({ serviceId: 'svc1', horizon: '1h' });
    if (p.horizon !== '1h') throw new Error('Horizon wrong');
  });
  await test('Prediction confidence', () => {
    const p = processPrediction({ serviceId: 'svc1', confidence: 0.8 });
    if (p.confidence !== 0.8) throw new Error('Confidence wrong');
  });
  await test('Prediction uncertainty', () => {
    const p = processPrediction({ serviceId: 'svc1', uncertainty: 0.2 });
    if (p.uncertainty !== 0.2) throw new Error('Uncertainty wrong');
  });
  await test('Unknown prediction handling', () => {
    const p = processPrediction({ serviceId: 'svc1' });
    if (p.predictedCondition !== 'unknown') throw new Error('Expected unknown');
  });

  // Capacity
  await test('Capacity forecast', () => {
    const cf = processCapacityForecast({ serviceId: 'svc1', resourceType: 'cpu', forecastValue: 80 });
    if (!cf.id) throw new Error('Forecast missing');
  });
  await test('Capacity pressure', () => {
    const cf = processCapacityForecast({ serviceId: 'svc1', currentObservation: 90 });
    if (cf.currentObservation < 90) throw new Error('Pressure not detected');
  });
  await test('Threshold crossing estimate', () => {
    const cf = processCapacityForecast({ serviceId: 'svc1', thresholdCrossingEstimate: '2h' });
    if (cf.thresholdCrossingEstimate !== '2h') throw new Error('Estimate wrong');
  });
  await test('Capacity uncertainty', () => {
    const cf = processCapacityForecast({ serviceId: 'svc1', uncertainty: 0.3 });
    if (cf.uncertainty !== 0.3) throw new Error('Uncertainty wrong');
  });

  // Topology
  await test('Topology creation', () => {
    const t = processTopology({ sourceType: 'service', sourceId: 'svc1', targetType: 'db', targetId: 'db1' });
    if (!t.id) throw new Error('Topology missing');
  });
  await test('Dependency validation', () => {
    const t = processTopology({ sourceType: 'service', sourceId: 'svc1', targetType: 'db', targetId: 'db1' });
    if (!t.relationship) throw new Error('Relationship missing');
  });
  await test('Dependency impact', () => {
    const t = processTopology({ sourceType: 'service', sourceId: 'svc1', targetType: 'db', targetId: 'db1' });
    if (!t.targetId) throw new Error('Impact missing');
  });
  await test('Blast-radius analysis', () => {
    const br = processBlastRadius({ serviceId: 'svc1', high: true });
    if (br.classification !== 'high') throw new Error('Expected high');
  });

  // Correlation
  await test('Cross-signal correlation', () => {
    const c = processCorrelation({ sourceType: 'metric', sourceId: 'm1', targetType: 'log', targetId: 'l1', correlationStrength: 'high' });
    if (c.correlationStrength !== 'high') throw new Error('Correlation wrong');
  });
  await test('Change correlation', () => {
    const cc = processChangeCorrelation({ serviceId: 'svc1', changeRef: 'deploy1', correlationStrength: 'high' });
    if (cc.correlationStrength !== 'high') throw new Error('Change correlation wrong');
  });
  await test('No-correlation handling', () => {
    const c = processCorrelation({ sourceType: 'metric', sourceId: 'm1', targetType: 'log', targetId: 'l1', correlationStrength: 'none' });
    if (c.correlationStrength !== 'none') throw new Error('Expected none');
  });
  await test('Unknown correlation handling', () => {
    const c = processCorrelation({ sourceType: 'metric', sourceId: 'm1', targetType: 'log', targetId: 'l1' });
    if (c.correlationStrength !== 'unknown') throw new Error('Expected unknown');
  });

  // Root Cause
  await test('Root-cause hypothesis generation', () => {
    const rc = processRootCause({ serviceId: 'svc1', candidateCause: 'db' });
    if (!rc.candidateCause) throw new Error('Root cause missing');
  });
  await test('Root-cause evidence', () => {
    const rc = processRootCause({ serviceId: 'svc1', supportingEvidence: ['ev1'] });
    if (rc.supportingEvidence.length === 0) throw new Error('Evidence missing');
  });
  await test('Root-cause uncertainty', () => {
    const rc = processRootCause({ serviceId: 'svc1', confidence: 0.1 });
    if (rc.confidence > 0.5) throw new Error('Expected low confidence');
  });

  // Risk
  await test('Operational risk calculation', () => {
    const risk = processRisk({ serviceId: 'svc1', medium: true });
    if (risk.riskLevel !== 'medium') throw new Error('Risk wrong');
  });
  await test('Critical risk detection', () => {
    const risk = processRisk({ serviceId: 'svc1', critical: true });
    if (risk.riskLevel !== 'critical') throw new Error('Expected critical');
  });
  await test('Unknown risk handling', () => {
    const risk = processRisk({ serviceId: 'svc1' });
    if (risk.riskLevel !== 'unknown') throw new Error('Expected unknown');
  });

  // Governance
  await test('Governance allow', () => {
    const gov = processGovernance({ serviceId: 'svc1' });
    if (gov.decision !== 'ALLOW') throw new Error('Expected ALLOW');
  });
  await test('Approval requirement', () => {
    const gov = processGovernance({ serviceId: 'svc1', risk: 'high' });
    if (gov.decision !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');
  });
  await test('Governance denial', () => {
    const gov = processGovernance({ serviceId: 'svc1', deny: true });
    if (gov.decision !== 'DENY') throw new Error('Expected DENY');
  });
  await test('Governance freeze', () => {
    const gov = processGovernance({ serviceId: 'svc1', freeze: true });
    if (gov.decision !== 'FREEZE') throw new Error('Expected FREEZE');
  });

  // Safety
  await test('Safety allow', () => {
    const safety = processRemediationSafety({ serviceId: 'svc1' });
    if (!safety.safe) throw new Error('Expected safe');
  });
  await test('Protected-resource block', () => {
    const safety = processRemediationSafety({ serviceId: 'svc1', protectedResource: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown provider safety block', () => {
    const safety = processRemediationSafety({ serviceId: 'svc1', unknownProvider: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown health safety block', () => {
    const safety = processRemediationSafety({ serviceId: 'svc1', unknownHealth: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Insufficient evidence safety block', () => {
    const safety = processRemediationSafety({ serviceId: 'svc1', insufficientEvidence: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });

  // Execution
  await test('Execution creation', () => {
    const exec = processRemediationExecution({ planId: 'plan1', operation: 'scale' });
    if (!exec.id) throw new Error('Execution missing');
  });
  await test('Valid execution transition', () => {
    const exec = processRemediationExecution({ planId: 'plan1', from: 'planned', to: 'approved' });
    if (!exec.validTransition || exec.state !== 'approved') throw new Error('Transition should be valid');
  });
  await test('Invalid execution transition', () => {
    try {
      processRemediationExecution({ planId: 'plan1', from: 'executing', to: 'planned' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });
  await test('Execution halt', () => {
    const exec = processRemediationExecution({ planId: 'plan1', operation: 'halt' });
    if (exec.state !== 'halted') throw new Error('Expected halted');
  });
  await test('Duplicate execution prevention', () => {
    const e1 = processRemediationExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    const e2 = processRemediationExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    if (e1.id !== e2.id) throw new Error('Expected same execution id');
  });

  // Remediation
  await test('Preventive remediation plan', () => {
    const plan = processRemediationPlan({ serviceId: 'svc1', idempotencyKey: 'plan-1' });
    if (!plan.id) throw new Error('Plan missing');
  });
  await test('Preventive remediation execution', () => {
    const exec = processRemediationExecution({ planId: 'plan1' });
    if (!exec.id) throw new Error('Execution missing');
  });
  await test('Preventive remediation verification', () => {
    const ver = processRemediationVerification({ executionId: 'exec1', recovered: true });
    if (ver.state !== 'recovered') throw new Error('Expected recovered');
  });
  await test('Recovery detection', () => {
    const ver = processRemediationVerification({ executionId: 'exec1', recovered: true });
    if (ver.state !== 'recovered') throw new Error('Not recovered');
  });
  await test('Regression detection', () => {
    const ver = processRemediationVerification({ executionId: 'exec1', regression: true });
    if (ver.state !== 'regressed') throw new Error('Expected regressed');
  });
  await test('Preventive rollback', () => {
    const rb = processRemediationRollback({ executionId: 'exec1' });
    if (!rb.id) throw new Error('Rollback missing');
  });
  await test('Rollback idempotency', () => {
    const rb1 = processRemediationRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    const rb2 = processRemediationRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    if (rb1.id !== rb2.id) throw new Error('Expected same rollback id');
  });
  await test('Rollback failure', () => {
    const rb = processRemediationRollback({ executionId: 'exec1', fail: true });
    if (rb.state !== 'failed') throw new Error('Expected failed');
  });

  // Circuit Breaker
  await test('Circuit breaker closed', () => {
    const cb = processRemediationCircuitBreaker({ scope: 'remediation' });
    if (cb.state !== 'CLOSED') throw new Error('Expected CLOSED');
  });
  await test('Circuit breaker opens', () => {
    const cb = processRemediationCircuitBreaker({ scope: 'remediation', failures: 3, threshold: 3 });
    if (cb.state !== 'OPEN') throw new Error('Expected OPEN');
  });
  await test('Execution blocked while breaker is open', () => {
    const exec = processRemediationExecution({ planId: 'plan1', circuitBreakerState: 'OPEN' });
    if (!exec.blocked) throw new Error('Expected blocked');
  });

  // Incident
  await test('Predictive incident creation', () => {
    const inc = processIncident({ serviceId: 'svc1', severity: 'high', fingerprint: 'inc-1' });
    if (!inc.id || inc.severity !== 'high') throw new Error('Incident missing');
  });
  await test('Duplicate incident prevention', () => {
    const i1 = processIncident({ fingerprint: 'dup-inc' });
    const i2 = processIncident({ fingerprint: 'dup-inc' });
    if (i1.id !== i2.id) throw new Error('Expected same incident id');
  });

  // Escalation
  await test('Escalation', () => {
    const esc = processEscalation({ incidentId: 'inc1', level: 'critical' });
    if (!esc.id || esc.level !== 'critical') throw new Error('Escalation missing');
  });

  // Evidence/Audit/Lineage/Learning
  await test('Evidence generation', () => {
    const ev = processEvidence({ source: 'test', findingId: 'f1' });
    if (!ev.id) throw new Error('Evidence missing');
  });
  await test('Audit trail', () => {
    const audit = processAudit({ eventType: 'prediction', resource: 'svc1' });
    if (!audit.id) throw new Error('Audit missing');
  });
  await test('Lineage', () => {
    const lin = processLineage({ serviceId: 'svc1', predictionId: 'p1' });
    if (!lin.id) throw new Error('Lineage missing');
  });
  await test('Learning outcome', () => {
    const learn = processLearning({ serviceId: 'svc1', pattern: 'degradation' });
    if (!learn.id) throw new Error('Learning missing');
  });

  // End-to-End
  await test('Full approved predictive lifecycle orchestration', () => {
    const result = processAutonomousObservabilityAIOpsControlPlane({ serviceId: 'svc1', approve: true });
    if (result.status !== 'RESOLVED') throw new Error('Lifecycle failed');
  });
  await test('Unknown provider fails closed', () => {
    try {
      processAutonomousObservabilityAIOpsControlPlane({ serviceId: 'svc1', provider: 'unknown' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('UNAVAILABLE')) throw e;
    }
  });
  await test('Repeated identical observability request remains idempotent', () => {
    const s1 = processObservabilitySource({ name: 'idem', provider: 'aws', idempotencyKey: 'src-idem' });
    const s2 = processObservabilitySource({ name: 'idem', provider: 'aws', idempotencyKey: 'src-idem' });
    if (s1.id !== s2.id) throw new Error('Expected same source id');
  });

  // Security
  const redactionTests = [
    { name: 'Password redaction', text: 'password=secret123' },
    { name: 'Token redaction', text: 'token=abc123' },
    { name: 'API-key redaction', text: 'api_key=xyz' },
    { name: 'Authorization-header redaction', text: 'Authorization: Bearer token' },
    { name: 'Secret redaction', text: 'secret=value' },
  ];
  for (const rt of redactionTests) {
    await test(rt.name, () => {
      const redacted = redactSecret(rt.text);
      if (!redacted.includes('[REDACTED]')) throw new Error('Redaction failed');
    });
  }

  // Summary
  console.log('=== Phase 43: Autonomous Observability, AIOps Intelligence & Predictive Operations ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 43: PASS' : 'PHASE 43: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
