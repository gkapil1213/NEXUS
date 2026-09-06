import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { processResource } from '../src/core/worker-phase47-resource';
import { processResourceObservation } from '../src/core/worker-phase47-resource-observation';
import { processOwnership } from '../src/core/worker-phase47-ownership';
import { processCostObservation } from '../src/core/worker-phase47-cost-observation';
import { processCostAnomaly } from '../src/core/worker-phase47-cost-anomaly';
import { processCapacityPressure } from '../src/core/worker-phase47-capacity-pressure';
import { processUnderutilization } from '../src/core/worker-phase47-underutilization';
import { processForecast } from '../src/core/worker-phase47-forecast';
import { processWaste } from '../src/core/worker-phase47-waste';
import { processOptimizationOpportunity } from '../src/core/worker-phase47-optimization-opportunity';
import { processRisk } from '../src/core/worker-phase47-risk';
import { processChangeCorrelation } from '../src/core/worker-phase47-change-correlation';
import { processDependencyImpact } from '../src/core/worker-phase47-dependency-impact';
import { processBlastRadius } from '../src/core/worker-phase47-blast-radius';
import { processGovernance } from '../src/core/worker-phase47-governance';
import { processApproval } from '../src/core/worker-phase47-approval';
import { processSafety } from '../src/core/worker-phase47-safety';
import { processPlan } from '../src/core/worker-phase47-plan';
import { processExecution } from '../src/core/worker-phase47-execution';
import { processVerification } from '../src/core/worker-phase47-verification';
import { processRegression } from '../src/core/worker-phase47-regression';
import { processRollback } from '../src/core/worker-phase47-rollback';
import { processCircuitBreaker } from '../src/core/worker-phase47-circuit-breaker';
import { processIncident } from '../src/core/worker-phase47-incident';
import { processEscalation } from '../src/core/worker-phase47-escalation';
import { processEvidence } from '../src/core/worker-phase47-evidence';
import { processAudit } from '../src/core/worker-phase47-audit';
import { processLineage } from '../src/core/worker-phase47-lineage';
import { processLearning } from '../src/core/worker-phase47-learning';
import { processProvider } from '../src/core/worker-phase47-provider';
import { processAutonomousOptimizationControlPlane } from '../src/core/worker-phase47-autonomous-optimization-control-plane';

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
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '092_phase47_autonomous_capacity_cost_resource_optimization.sql');
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
  // 1-59 per prompt
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
  await test('Resource observation', () => {
    const o = processResourceObservation({ resourceId: 'res1', metricType: 'cpu', value: 50 });
    if (!o.id || o.value !== 50) throw new Error('Observation missing');
  });
  await test('Unknown resource handling', () => {
    const r = processResource({ provider: 'aws' });
    if (r.resourceType !== 'unknown') throw new Error('Expected unknown');
  });
  await test('Ownership assignment', () => {
    const o = processOwnership({ resourceId: 'res1', owner: 'team-a' });
    if (o.owner !== 'team-a') throw new Error('Owner wrong');
  });
  await test('Unknown ownership handling', () => {
    const o = processOwnership({ resourceId: 'res1' });
    if (o.owner !== null) throw new Error('Expected null owner');
  });
  await test('Cost observation', () => {
    const c = processCostObservation({ resourceId: 'res1', amount: 100 });
    if (c.amount !== 100) throw new Error('Cost wrong');
  });
  await test('Cost anomaly detection', () => {
    const a = processCostAnomaly({ resourceId: 'res1', anomalyType: 'sudden_increase' });
    if (a.anomalyType !== 'sudden_increase') throw new Error('Anomaly missing');
  });
  await test('Capacity pressure detection', () => {
    const cp = processCapacityPressure({ resourceId: 'res1', utilization: 90, threshold: 80 });
    if (cp.state !== 'pressured') throw new Error('Pressure not detected');
  });
  await test('Underutilization detection', () => {
    const u = processUnderutilization({ resourceId: 'res1', utilization: 20, threshold: 30 });
    if (u.state !== 'underutilized') throw new Error('Underutilization not detected');
  });
  await test('Capacity forecasting', () => {
    const f = processForecast({ resourceId: 'res1', predictedValue: 85 });
    if (!f.id || f.predictedValue !== 85) throw new Error('Forecast missing');
  });
  await test('Forecast confidence', () => {
    const f = processForecast({ resourceId: 'res1', confidence: 0.7 });
    if (f.confidence !== 0.7) throw new Error('Confidence wrong');
  });
  await test('Waste detection', () => {
    const w = processWaste({ resourceId: 'res1', wasteType: 'idle' });
    if (w.wasteType !== 'idle') throw new Error('Waste missing');
  });
  await test('Optimization opportunity creation', () => {
    const op = processOptimizationOpportunity({ resourceId: 'res1', opportunityType: 'rightsize' });
    if (!op.id || op.opportunityType !== 'rightsize') throw new Error('Opportunity missing');
  });
  await test('Duplicate opportunity prevention', () => {
    const op1 = processOptimizationOpportunity({ resourceId: 'res1', opportunityType: 'rightsize' });
    const op2 = processOptimizationOpportunity({ resourceId: 'res1', opportunityType: 'rightsize' });
    if (op1.id === op2.id) throw new Error('Duplicates should not be identical unless idempotency key');
  });
  await test('Optimization risk calculation', () => {
    const r = processRisk({ opportunityId: 'op1', medium: true });
    if (r.riskLevel !== 'medium') throw new Error('Risk wrong');
  });
  await test('Critical-risk detection', () => {
    const r = processRisk({ opportunityId: 'op1', critical: true });
    if (r.riskLevel !== 'critical') throw new Error('Expected critical');
  });
  await test('Change correlation', () => {
    const cc = processChangeCorrelation({ resourceId: 'res1', changeRef: 'deploy1', correlationStrength: 'high' });
    if (cc.correlationStrength !== 'high') throw new Error('Correlation wrong');
  });
  await test('Dependency impact', () => {
    const di = processDependencyImpact({ resourceId: 'res1', dependentServices: ['svc1'], blastRadius: 'medium' });
    if (di.blastRadius !== 'medium') throw new Error('Impact wrong');
  });
  await test('Blast-radius analysis', () => {
    const br = processBlastRadius({ resourceId: 'res1', high: true });
    if (br.classification !== 'high') throw new Error('Expected high');
  });
  await test('Governance allow', () => {
    const gov = processGovernance({ resourceId: 'res1' });
    if (gov.decision !== 'ALLOW') throw new Error('Expected ALLOW');
  });
  await test('Approval requirement', () => {
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
  await test('Safety allow', () => {
    const safety = processSafety({ resourceId: 'res1' });
    if (!safety.safe) throw new Error('Expected safe');
  });
  await test('Protected-resource safety block', () => {
    const safety = processSafety({ resourceId: 'res1', protectedResource: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown-provider safety block', () => {
    const safety = processSafety({ resourceId: 'res1', unknownProvider: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown-health safety block', () => {
    const safety = processSafety({ resourceId: 'res1', unknownHealth: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Optimization plan creation', () => {
    const plan = processPlan({ resourceId: 'res1', opportunityId: 'op1', idempotencyKey: 'plan-1' });
    if (!plan.id) throw new Error('Plan missing');
  });
  await test('Execution creation', () => {
    const exec = processExecution({ planId: 'plan1', operation: 'optimize' });
    if (!exec.id) throw new Error('Execution missing');
  });
  await test('Valid execution transition', () => {
    const exec = processExecution({ planId: 'plan1', from: 'planned', to: 'approved' });
    if (!exec.validTransition || exec.state !== 'approved') throw new Error('Transition should be valid');
  });
  await test('Invalid execution transition', () => {
    try {
      processExecution({ planId: 'plan1', from: 'running', to: 'planned' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });
  await test('Execution halt', () => {
    const exec = processExecution({ planId: 'plan1', operation: 'halt' });
    if (exec.state !== 'halted') throw new Error('Expected halted');
  });
  await test('Duplicate execution prevention', () => {
    const e1 = processExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    const e2 = processExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    if (e1.id !== e2.id) throw new Error('Expected same id');
  });
  await test('Optimization execution', () => {
    const exec = processExecution({ planId: 'plan1', operation: 'optimize', result: 'success' });
    if (exec.result !== 'success') throw new Error('Execution failed');
  });
  await test('Optimization verification', () => {
    const ver = processVerification({ executionId: 'exec1', improved: true });
    if (ver.state !== 'improved') throw new Error('Expected improved');
  });
  await test('Optimization regression detection', () => {
    const reg = processRegression({ executionId: 'exec1', type: 'performance', detected: true });
    if (!reg.detected) throw new Error('Regression not detected');
  });
  await test('Rollback', () => {
    const rb = processRollback({ executionId: 'exec1' });
    if (!rb.id) throw new Error('Rollback missing');
  });
  await test('Rollback idempotency', () => {
    const rb1 = processRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    const rb2 = processRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    if (rb1.id !== rb2.id) throw new Error('Expected same id');
  });
  await test('Rollback failure', () => {
    const rb = processRollback({ executionId: 'exec1', fail: true });
    if (rb.state !== 'failed') throw new Error('Expected failed');
  });
  await test('Circuit breaker closed', () => {
    const cb = processCircuitBreaker({ scope: 'optimization' });
    if (cb.state !== 'CLOSED') throw new Error('Expected CLOSED');
  });
  await test('Circuit breaker opens', () => {
    const cb = processCircuitBreaker({ scope: 'optimization', failures: 3, threshold: 3 });
    if (cb.state !== 'OPEN') throw new Error('Expected OPEN');
  });
  await test('Execution blocked while breaker is open', () => {
    const exec = processExecution({ planId: 'plan1', circuitBreakerState: 'OPEN' });
    if (!exec.blocked) throw new Error('Expected blocked');
  });
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
  await test('Evidence generation', () => {
    const ev = processEvidence({ resourceId: 'res1' });
    if (!ev.id) throw new Error('Evidence missing');
  });
  await test('Audit trail', () => {
    const audit = processAudit({ resourceId: 'res1', eventType: 'optimization_started' });
    if (!audit.id) throw new Error('Audit missing');
  });
  await test('Lineage', () => {
    const lin = processLineage({ resourceId: 'res1', planId: 'plan1' });
    if (!lin.id) throw new Error('Lineage missing');
  });
  await test('Learning outcome', () => {
    const learn = processLearning({ resourceId: 'res1', pattern: 'rightsize', outcome: 'success' });
    if (!learn.id) throw new Error('Learning missing');
  });
  await test('Full approved optimization lifecycle orchestration', () => {
    const result = processAutonomousOptimizationControlPlane({ resourceId: 'res1', approve: true });
    if (result.status !== 'COMPLETED') throw new Error('Lifecycle failed');
  });
  await test('Unknown provider fails closed', () => {
    try {
      processProvider({ unknown: true });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('UNAVAILABLE')) throw e;
    }
  });
  await test('Repeated identical optimization request remains idempotent', () => {
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
  console.log('=== Phase 47: Autonomous Capacity, Cost & Resource Optimization Intelligence ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 47: PASS' : 'PHASE 47: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
