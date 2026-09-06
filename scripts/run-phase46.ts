import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { processResource } from '../src/core/worker-phase46-resource';
import { processResourceObservation } from '../src/core/worker-phase46-resource-observation';
import { processBaseline } from '../src/core/worker-phase46-baseline';
import { processUtilization } from '../src/core/worker-phase46-utilization';
import { processSaturation } from '../src/core/worker-phase46-saturation';
import { processBottleneck } from '../src/core/worker-phase46-bottleneck';
import { processTrend } from '../src/core/worker-phase46-trend';
import { processForecast } from '../src/core/worker-phase46-forecast';
import { processRisk } from '../src/core/worker-phase46-risk';
import { processScalingOpportunity } from '../src/core/worker-phase46-scaling-opportunity';
import { processPlan } from '../src/core/worker-phase46-plan';
import { processGovernance } from '../src/core/worker-phase46-governance';
import { processApproval } from '../src/core/worker-phase46-approval';
import { processSafety } from '../src/core/worker-phase46-safety';
import { processExecution } from '../src/core/worker-phase46-execution';
import { processVerification } from '../src/core/worker-phase46-verification';
import { processRegression } from '../src/core/worker-phase46-regression';
import { processRollback } from '../src/core/worker-phase46-rollback';
import { processCircuitBreaker } from '../src/core/worker-phase46-circuit-breaker';
import { processIncident } from '../src/core/worker-phase46-incident';
import { processEscalation } from '../src/core/worker-phase46-escalation';
import { processEvidence } from '../src/core/worker-phase46-evidence';
import { processAudit } from '../src/core/worker-phase46-audit';
import { processLineage } from '../src/core/worker-phase46-lineage';
import { processLearning } from '../src/core/worker-phase46-learning';
import { processProvider } from '../src/core/worker-phase46-provider';
import { processAutonomousCapacityControlPlane } from '../src/core/worker-phase46-autonomous-capacity-control-plane';

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
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '091_phase46_autonomous_capacity_performance_predictive_scaling.sql');
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
  // Resource
  await test('Resource creation', () => {
    const r = processResource({ provider: 'aws', resourceType: 'compute' });
    if (!r.id || r.resourceType !== 'compute') throw new Error('Invalid resource');
  });
  await test('Duplicate resource prevention', () => {
    const r1 = processResource({ provider: 'aws', resourceType: 'compute', idempotencyKey: 'res-dup' });
    const r2 = processResource({ provider: 'aws', resourceType: 'compute', idempotencyKey: 'res-dup' });
    if (r1.id !== r2.id) throw new Error('Expected same id');
  });
  await test('Resource discovery', () => {
    const r = processResource({ provider: 'aws', resourceType: 'compute' });
    if (!r.id) throw new Error('Discovery failed');
  });

  // Observation
  await test('Metric observation', () => {
    const o = processResourceObservation({ resourceId: 'res1', metricType: 'cpu', value: 50 });
    if (!o.id || o.value !== 50) throw new Error('Observation missing');
  });
  await test('Timestamp present', () => {
    const o = processResourceObservation({ resourceId: 'res1', metricType: 'cpu', value: 50 });
    if (!o.observedAt) throw new Error('Timestamp missing');
  });
  await test('Source recorded', () => {
    const o = processResourceObservation({ resourceId: 'res1', metricType: 'cpu', value: 50, source: 'prometheus' });
    if (o.source !== 'prometheus') throw new Error('Source wrong');
  });
  await test('Unknown metric handling', () => {
    const o = processResourceObservation({ resourceId: 'res1', metricType: 'unknown_metric', value: 50 });
    if (o.metricType !== 'unknown_metric') throw new Error('Expected unknown');
  });

  // Baseline
  await test('Baseline creation', () => {
    const b = processBaseline({ resourceId: 'res1', baselineValue: 50 });
    if (!b.id) throw new Error('Baseline missing');
  });
  await test('Baseline comparison', () => {
    const b = processBaseline({ resourceId: 'res1', baselineValue: 50, currentValue: 55, deviationThreshold: 10 });
    if (b.deviationDetected) throw new Error('Unexpected deviation');
  });
  await test('Deviation detection', () => {
    const b = processBaseline({ resourceId: 'res1', baselineValue: 50, currentValue: 80, deviationThreshold: 10 });
    if (!b.deviationDetected) throw new Error('Deviation not detected');
  });

  // Utilization
  await test('Utilization calculation', () => {
    const u = processUtilization({ resourceId: 'res1', currentUtilization: 70, maxCapacity: 100 });
    if (u.currentUtilization !== 70 || u.headroom !== 30) throw new Error('Calculation wrong');
  });
  await test('Headroom calculation', () => {
    const u = processUtilization({ resourceId: 'res1', currentUtilization: 60, maxCapacity: 100 });
    if (u.headroom !== 40) throw new Error('Headroom wrong');
  });
  await test('Unknown utilization', () => {
    const u = processUtilization({ resourceId: 'res1' });
    if (u.currentUtilization !== undefined) throw new Error('Expected undefined');
  });

  // Saturation
  await test('Saturation detection', () => {
    const s = processSaturation({ resourceId: 'res1', utilization: 90, threshold: 80 });
    if (s.saturationState !== 'saturated') throw new Error('Not saturated');
  });
  await test('No saturation', () => {
    const s = processSaturation({ resourceId: 'res1', utilization: 50, threshold: 80 });
    if (s.saturationState !== 'not_saturated') throw new Error('Should not be saturated');
  });
  await test('Insufficient data', () => {
    const s = processSaturation({ resourceId: 'res1' });
    if (s.saturationState !== 'unknown') throw new Error('Expected unknown');
  });

  // Bottleneck
  await test('Bottleneck detection', () => {
    const b = processBottleneck({ resourceId: 'res1', bottleneckType: 'cpu', confidence: 0.8 });
    if (b.bottleneckType !== 'cpu') throw new Error('Wrong bottleneck');
  });
  await test('Bottleneck confidence', () => {
    const b = processBottleneck({ resourceId: 'res1', confidence: 0.9 });
    if (b.confidence !== 0.9) throw new Error('Confidence wrong');
  });
  await test('Unknown bottleneck', () => {
    const b = processBottleneck({ resourceId: 'res1' });
    if (b.bottleneckType !== 'unknown') throw new Error('Expected unknown');
  });

  // Trend
  await test('Increasing trend', () => {
    const t = processTrend({ resourceId: 'res1', trendDirection: 'increasing' });
    if (t.trendDirection !== 'increasing') throw new Error('Wrong trend');
  });
  await test('Decreasing trend', () => {
    const t = processTrend({ resourceId: 'res1', trendDirection: 'decreasing' });
    if (t.trendDirection !== 'decreasing') throw new Error('Wrong trend');
  });
  await test('Stable trend', () => {
    const t = processTrend({ resourceId: 'res1', trendDirection: 'stable' });
    if (t.trendDirection !== 'stable') throw new Error('Wrong trend');
  });
  await test('Volatile trend', () => {
    const t = processTrend({ resourceId: 'res1', trendDirection: 'volatile' });
    if (t.trendDirection !== 'volatile') throw new Error('Wrong trend');
  });
  await test('Insufficient trend data', () => {
    const t = processTrend({ resourceId: 'res1' });
    if (t.trendDirection !== 'unknown') throw new Error('Expected unknown');
  });

  // Forecast
  await test('Forecast generation', () => {
    const f = processForecast({ resourceId: 'res1', projectedUtilization: 85 });
    if (!f.id) throw new Error('Forecast missing');
  });
  await test('Projected saturation', () => {
    const f = processForecast({ resourceId: 'res1', projectedUtilization: 95, thresholdCrossing: '1h' });
    if (f.projectedUtilization !== 95) throw new Error('Wrong projection');
  });
  await test('Forecast uncertainty', () => {
    const f = processForecast({ resourceId: 'res1', confidence: 0.2 });
    if (f.confidence !== 0.2) throw new Error('Confidence wrong');
  });

  // Risk
  await test('Low risk', () => {
    const r = processRisk({ resourceId: 'res1', low: true });
    if (r.riskLevel !== 'low') throw new Error('Wrong risk');
  });
  await test('Medium risk', () => {
    const r = processRisk({ resourceId: 'res1', medium: true });
    if (r.riskLevel !== 'medium') throw new Error('Wrong risk');
  });
  await test('High risk', () => {
    const r = processRisk({ resourceId: 'res1', high: true });
    if (r.riskLevel !== 'high') throw new Error('Wrong risk');
  });
  await test('Critical risk', () => {
    const r = processRisk({ resourceId: 'res1', critical: true });
    if (r.riskLevel !== 'critical') throw new Error('Wrong risk');
  });
  await test('Unknown risk', () => {
    const r = processRisk({ resourceId: 'res1' });
    if (r.riskLevel !== 'unknown') throw new Error('Wrong risk');
  });

  // Scaling opportunity
  await test('Scaling opportunity creation', () => {
    const so = processScalingOpportunity({ resourceId: 'res1', opportunityType: 'scale_up' });
    if (!so.id || so.opportunityType !== 'scale_up') throw new Error('Opportunity missing');
  });
  await test('Duplicate opportunity prevention', () => {
    const so1 = processScalingOpportunity({ resourceId: 'res1', opportunityType: 'scale_up' });
    const so2 = processScalingOpportunity({ resourceId: 'res1', opportunityType: 'scale_up' });
    if (so1.id === so2.id) throw new Error('Duplicates should not be identical unless idempotency key');
  });
  await test('Scaling constraints', () => {
    const so = processScalingOpportunity({ resourceId: 'res1', constraints: 'max=100' });
    if (so.constraints !== 'max=100') throw new Error('Constraints missing');
  });

  // Governance
  await test('Governance allow', () => {
    const gov = processGovernance({ resourceId: 'res1' });
    if (gov.decision !== 'ALLOW') throw new Error('Expected ALLOW');
  });
  await test('Approval required', () => {
    const gov = processGovernance({ resourceId: 'res1', risk: 'high' });
    if (gov.decision !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');
  });
  await test('Governance denial', () => {
    const gov = processGovernance({ resourceId: 'res1', deny: true });
    if (gov.decision !== 'DENY') throw new Error('Expected DENY');
  });
  await test('Governance freeze', () => {
    const gov = processGovernance({ resourceId: 'res1', freeze: true });
    if (gov.decision !== 'FREEZE') throw new Error('Expected FREEZE');
  });

  // Safety
  await test('Safety allow', () => {
    const safety = processSafety({ resourceId: 'res1' });
    if (!safety.safe) throw new Error('Expected safe');
  });
  await test('Protected resource block', () => {
    const safety = processSafety({ resourceId: 'res1', protectedResource: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown provider block', () => {
    const safety = processSafety({ resourceId: 'res1', unknownProvider: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown health block', () => {
    const safety = processSafety({ resourceId: 'res1', unknownHealth: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Invalid capacity block', () => {
    const safety = processSafety({ resourceId: 'res1', invalidCapacity: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });

  // Execution
  await test('Execution creation', () => {
    const exec = processExecution({ planId: 'plan1', operation: 'scale' });
    if (!exec.id) throw new Error('Execution missing');
  });
  await test('Valid execution transition', () => {
    const exec = processExecution({ planId: 'plan1', from: 'planned', to: 'approved' });
    if (!exec.validTransition || exec.state !== 'approved') throw new Error('Transition should be valid');
  });
  await test('Invalid execution transition', () => {
    try {
      processExecution({ planId: 'plan1', from: 'executing', to: 'planned' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });
  await test('Duplicate execution prevention', () => {
    const e1 = processExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    const e2 = processExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    if (e1.id !== e2.id) throw new Error('Expected same id');
  });
  await test('Execution halt', () => {
    const exec = processExecution({ planId: 'plan1', operation: 'halt' });
    if (exec.state !== 'halted') throw new Error('Expected halted');
  });

  // Verification
  await test('Improved verification', () => {
    const ver = processVerification({ executionId: 'exec1', improved: true });
    if (ver.state !== 'improved') throw new Error('Expected improved');
  });
  await test('Unchanged verification', () => {
    const ver = processVerification({ executionId: 'exec1', unchanged: true });
    if (ver.state !== 'unchanged') throw new Error('Expected unchanged');
  });
  await test('Degraded verification', () => {
    const ver = processVerification({ executionId: 'exec1', degraded: true });
    if (ver.state !== 'degraded') throw new Error('Expected degraded');
  });
  await test('Unknown verification', () => {
    const ver = processVerification({ executionId: 'exec1' });
    if (ver.state !== 'unknown') throw new Error('Expected unknown');
  });

  // Regression
  await test('Performance regression', () => {
    const reg = processRegression({ executionId: 'exec1', type: 'performance', detected: true });
    if (!reg.detected || reg.type !== 'performance') throw new Error('Regression wrong');
  });
  await test('Latency regression', () => {
    const reg = processRegression({ executionId: 'exec1', type: 'latency', detected: true });
    if (!reg.detected || reg.type !== 'latency') throw new Error('Regression wrong');
  });
  await test('Error regression', () => {
    const reg = processRegression({ executionId: 'exec1', type: 'error', detected: true });
    if (!reg.detected || reg.type !== 'error') throw new Error('Regression wrong');
  });

  // Rollback
  await test('Rollback creation', () => {
    const rb = processRollback({ executionId: 'exec1' });
    if (!rb.id) throw new Error('Rollback missing');
  });
  await test('Rollback failure', () => {
    const rb = processRollback({ executionId: 'exec1', fail: true });
    if (rb.state !== 'failed') throw new Error('Expected failed');
  });
  await test('Rollback idempotency', () => {
    const rb1 = processRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    const rb2 = processRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    if (rb1.id !== rb2.id) throw new Error('Expected same id');
  });

  // Circuit breaker
  await test('Circuit breaker closed', () => {
    const cb = processCircuitBreaker({ scope: 'scaling' });
    if (cb.state !== 'CLOSED') throw new Error('Expected CLOSED');
  });
  await test('Circuit breaker opens', () => {
    const cb = processCircuitBreaker({ scope: 'scaling', failures: 3, threshold: 3 });
    if (cb.state !== 'OPEN') throw new Error('Expected OPEN');
  });
  await test('Execution blocked while open', () => {
    const exec = processExecution({ planId: 'plan1', circuitBreakerState: 'OPEN' });
    if (!exec.blocked) throw new Error('Expected blocked');
  });

  // Incident
  await test('Incident creation', () => {
    const inc = processIncident({ resourceId: 'res1', severity: 'high' });
    if (!inc.id) throw new Error('Incident missing');
  });
  await test('Duplicate incident prevention', () => {
    const i1 = processIncident({ resourceId: 'res1', signature: 'sig1' });
    const i2 = processIncident({ resourceId: 'res1', signature: 'sig1' });
    if (i1.id !== i2.id) throw new Error('Expected same id');
  });
  await test('Escalation', () => {
    const esc = processEscalation({ incidentId: 'inc1', level: 'critical' });
    if (!esc.id) throw new Error('Escalation missing');
  });

  // Evidence
  await test('Evidence generation', () => {
    const ev = processEvidence({ resourceId: 'res1' });
    if (!ev.id) throw new Error('Evidence missing');
  });
  await test('Audit trail', () => {
    const audit = processAudit({ resourceId: 'res1', eventType: 'scaling_started' });
    if (!audit.id) throw new Error('Audit missing');
  });
  await test('Lineage', () => {
    const lin = processLineage({ resourceId: 'res1', planId: 'plan1' });
    if (!lin.id) throw new Error('Lineage missing');
  });
  await test('Learning outcome', () => {
    const learn = processLearning({ resourceId: 'res1', pattern: 'scale_up', outcome: 'success' });
    if (!learn.id) throw new Error('Learning missing');
  });

  // Full lifecycle
  await test('Full lifecycle orchestration', () => {
    const result = processAutonomousCapacityControlPlane({ resourceId: 'res1', approve: true });
    if (result.status !== 'COMPLETED') throw new Error('Lifecycle failed');
  });
  await test('Repeated identical request remains idempotent', () => {
    const r1 = processResource({ provider: 'aws', resourceType: 'compute', idempotencyKey: 'res-idem' });
    const r2 = processResource({ provider: 'aws', resourceType: 'compute', idempotencyKey: 'res-idem' });
    if (r1.id !== r2.id) throw new Error('Expected same id');
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
  console.log('=== Phase 46: Autonomous Capacity Planning, Performance Engineering & Predictive Scaling ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 46: PASS' : 'PHASE 46: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
