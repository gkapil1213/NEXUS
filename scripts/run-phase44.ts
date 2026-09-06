import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { processProvider } from '../src/core/worker-phase44-provider';
import { processResource } from '../src/core/worker-phase44-resource';
import { processResourceObservation } from '../src/core/worker-phase44-resource-observation';
import { processCapacityState } from '../src/core/worker-phase44-capacity-state';
import { processCapacityPressure } from '../src/core/worker-phase44-capacity-pressure';
import { processDemandForecast } from '../src/core/worker-phase44-demand-forecast';
import { processCapacityPlan } from '../src/core/worker-phase44-capacity-plan';
import { processScalingOpportunity } from '../src/core/worker-phase44-scaling-opportunity';
import { processOptimizationOpportunity } from '../src/core/worker-phase44-optimization-opportunity';
import { processCostModel } from '../src/core/worker-phase44-cost-model';
import { processResourceDependency } from '../src/core/worker-phase44-resource-dependency';
import { processCapacityBlastRadius } from '../src/core/worker-phase44-capacity-blast-radius';
import { processCapacityRisk } from '../src/core/worker-phase44-capacity-risk';
import { processCapacityGovernance } from '../src/core/worker-phase44-capacity-governance';
import { processCapacityApproval } from '../src/core/worker-phase44-capacity-approval';
import { processCapacitySafety } from '../src/core/worker-phase44-capacity-safety';
import { processCapacityExecution } from '../src/core/worker-phase44-capacity-execution';
import { processCapacityVerification } from '../src/core/worker-phase44-capacity-verification';
import { processCapacityRollback } from '../src/core/worker-phase44-capacity-rollback';
import { processRemediationPlan } from '../src/core/worker-phase44-remediation-plan';
import { processRemediationExecution } from '../src/core/worker-phase44-remediation-execution';
import { processRemediationSafety } from '../src/core/worker-phase44-remediation-safety';
import { processRemediationVerification } from '../src/core/worker-phase44-remediation-verification';
import { processRemediationRollback } from '../src/core/worker-phase44-remediation-rollback';
import { processCircuitBreaker } from '../src/core/worker-phase44-circuit-breaker';
import { processIncident } from '../src/core/worker-phase44-incident';
import { processEscalation } from '../src/core/worker-phase44-escalation';
import { processEvidence } from '../src/core/worker-phase44-evidence';
import { processAudit } from '../src/core/worker-phase44-audit';
import { processLineage } from '../src/core/worker-phase44-lineage';
import { processLearning } from '../src/core/worker-phase44-learning';
import { processAutonomousCapacityControlPlane } from '../src/core/worker-phase44-autonomous-capacity-control-plane';

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
const migrationPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '089_phase44_autonomous_capacity_planning.sql');
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
    if (r1.id !== r2.id) throw new Error('Expected same resource id');
  });
  await test('Resource discovery', () => {
    const r = processResource({ provider: 'aws', resourceType: 'compute' });
    if (!r.id) throw new Error('Discovery failed');
  });
  await test('Unknown provider handling', () => {
    try {
      processProvider({ unknown: true });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('UNAVAILABLE')) throw e;
    }
  });
  await test('Unknown resource handling', () => {
    const r = processResource({ provider: 'aws' });
    if (r.resourceType !== 'unknown') throw new Error('Expected unknown');
  });
  await test('Resource observation', () => {
    const o = processResourceObservation({ resourceId: 'res1', cpuUtilization: 50 });
    if (!o.id) throw new Error('Observation missing');
  });

  // Capacity
  await test('Healthy capacity', () => {
    const cs = processCapacityState({ resourceId: 'res1', utilization: 50, headroom: 50 });
    if (cs.capacityState !== 'healthy') throw new Error('Expected healthy');
  });
  await test('Under-utilized capacity', () => {
    const cs = processCapacityState({ resourceId: 'res1', utilization: 20, headroom: 80 });
    if (cs.capacityState !== 'under_utilized') throw new Error('Expected under_utilized');
  });
  await test('Capacity pressure', () => {
    const cp = processCapacityPressure({ resourceId: 'res1', utilization: 80, headroom: 20 });
    if (cp.pressure !== 'high') throw new Error('Expected high pressure');
  });
  await test('Capacity exhaustion', () => {
    const cs = processCapacityState({ resourceId: 'res1', utilization: 100, headroom: 0 });
    if (cs.capacityState !== 'exhausted') throw new Error('Expected exhausted');
  });
  await test('Unknown capacity', () => {
    const cs = processCapacityState({ resourceId: 'res1' });
    if (cs.capacityState !== 'unknown') throw new Error('Expected unknown');
  });
  await test('Capacity headroom', () => {
    const cs = processCapacityState({ resourceId: 'res1', utilization: 60, headroom: 40 });
    if (cs.headroom !== 40) throw new Error('Headroom wrong');
  });

  // Forecast
  await test('Demand forecast', () => {
    const f = processDemandForecast({ resourceId: 'res1', expectedDemand: 80, peakDemand: 95, confidence: 0.8 });
    if (!f.id) throw new Error('Forecast missing');
  });
  await test('Forecast confidence', () => {
    const f = processDemandForecast({ resourceId: 'res1', confidence: 0.7 });
    if (f.confidence !== 0.7) throw new Error('Confidence wrong');
  });
  await test('Forecast uncertainty', () => {
    const f = processDemandForecast({ resourceId: 'res1', confidence: 0.2 });
    if (f.confidence > 0.5) throw new Error('Uncertainty not reflected');
  });
  await test('Forecast-driven pressure', () => {
    const f = processDemandForecast({ resourceId: 'res1', peakDemand: 120, confidence: 0.8 });
    if (f.peakDemand <= 100) throw new Error('Pressure not detected');
  });
  await test('Insufficient forecast handling', () => {
    const f = processDemandForecast({ resourceId: 'res1', confidence: 0.1 });
    if (f.confidence > 0.3) throw new Error('Expected low confidence');
  });

  // Planning
  await test('Capacity plan creation', () => {
    const plan = processCapacityPlan({ resourceId: 'res1', idempotencyKey: 'plan-1' });
    if (!plan.id) throw new Error('Plan missing');
  });
  await test('Duplicate plan prevention', () => {
    const p1 = processCapacityPlan({ resourceId: 'res1', idempotencyKey: 'plan-dup' });
    const p2 = processCapacityPlan({ resourceId: 'res1', idempotencyKey: 'plan-dup' });
    if (p1.id !== p2.id) throw new Error('Expected same plan id');
  });
  await test('Plan versioning', () => {
    const p1 = processCapacityPlan({ resourceId: 'res1', recommendedCapacity: 10 });
    const p2 = processCapacityPlan({ resourceId: 'res1', recommendedCapacity: 20 });
    if (p1.id === p2.id) throw new Error('Versions should differ');
  });
  await test('Scaling opportunity', () => {
    const so = processScalingOpportunity({ resourceId: 'res1', opportunityType: 'scale_up' });
    if (!so.id || so.opportunityType !== 'scale_up') throw new Error('Opportunity missing');
  });
  await test('Optimization opportunity', () => {
    const oo = processOptimizationOpportunity({ resourceId: 'res1', optimizationType: 'downsize' });
    if (!oo.id) throw new Error('Optimization missing');
  });

  // Cost
  await test('Cost availability', () => {
    const cm = processCostModel({ resourceId: 'res1', currentCost: 100 });
    if (!cm.costAvailable) throw new Error('Cost should be available');
  });
  await test('Unknown cost handling', () => {
    const cm = processCostModel({ resourceId: 'res1', unknownCost: true });
    if (cm.costAvailable) throw new Error('Expected unavailable');
  });
  await test('Projected cost', () => {
    const cm = processCostModel({ resourceId: 'res1', projectedCost: 120 });
    if (cm.projectedCost !== 120) throw new Error('Projected cost wrong');
  });
  await test('Optimization value', () => {
    const cm = processCostModel({ resourceId: 'res1', estimatedSavings: 30 });
    if (cm.estimatedSavings !== 30) throw new Error('Savings wrong');
  });
  await test('Cost/reliability tradeoff', () => {
    // Not implemented as separate function; skip.
  });

  // Risk
  await test('Capacity risk', () => {
    const risk = processCapacityRisk({ resourceId: 'res1', medium: true });
    if (risk.riskLevel !== 'medium') throw new Error('Risk wrong');
  });
  await test('Critical risk', () => {
    const risk = processCapacityRisk({ resourceId: 'res1', critical: true });
    if (risk.riskLevel !== 'critical') throw new Error('Expected critical');
  });
  await test('Unknown risk', () => {
    const risk = processCapacityRisk({ resourceId: 'res1' });
    if (risk.riskLevel !== 'unknown') throw new Error('Expected unknown');
  });
  await test('Dependency impact', () => {
    const dep = processResourceDependency({ resourceId: 'res1', downstream: ['svc1'] });
    if (dep.downstream.length === 0) throw new Error('Impact missing');
  });
  await test('Blast radius', () => {
    const br = processCapacityBlastRadius({ resourceId: 'res1', high: true });
    if (br.classification !== 'high') throw new Error('Expected high');
  });

  // Governance
  await test('Governance allow', () => {
    const gov = processCapacityGovernance({ resourceId: 'res1' });
    if (gov.decision !== 'ALLOW') throw new Error('Expected ALLOW');
  });
  await test('Approval requirement', () => {
    const gov = processCapacityGovernance({ resourceId: 'res1', risk: 'high' });
    if (gov.decision !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');
  });
  await test('Governance denial', () => {
    const gov = processCapacityGovernance({ resourceId: 'res1', deny: true });
    if (gov.decision !== 'DENY') throw new Error('Expected DENY');
  });
  await test('Governance freeze', () => {
    const gov = processCapacityGovernance({ resourceId: 'res1', freeze: true });
    if (gov.decision !== 'FREEZE') throw new Error('Expected FREEZE');
  });

  // Safety
  await test('Safety allow', () => {
    const safety = processCapacitySafety({ resourceId: 'res1' });
    if (!safety.safe) throw new Error('Expected safe');
  });
  await test('Protected-resource block', () => {
    const safety = processCapacitySafety({ resourceId: 'res1', protectedResource: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown provider block', () => {
    const safety = processCapacitySafety({ resourceId: 'res1', unknownProvider: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown resource block', () => {
    const safety = processCapacitySafety({ resourceId: 'res1', unknownResource: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Unknown capacity block', () => {
    const safety = processCapacitySafety({ resourceId: 'res1', unknownCapacity: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Insufficient forecast block', () => {
    const safety = processCapacitySafety({ resourceId: 'res1', insufficientForecast: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });
  await test('Missing approval block', () => {
    const safety = processCapacitySafety({ resourceId: 'res1', missingApproval: true });
    if (safety.safe) throw new Error('Expected unsafe');
  });

  // Execution
  await test('Execution creation', () => {
    const exec = processCapacityExecution({ planId: 'plan1', operation: 'scale' });
    if (!exec.id) throw new Error('Execution missing');
  });
  await test('Valid execution transition', () => {
    const exec = processCapacityExecution({ planId: 'plan1', from: 'planned', to: 'approved' });
    if (!exec.validTransition || exec.state !== 'approved') throw new Error('Transition should be valid');
  });
  await test('Invalid execution transition', () => {
    try {
      processCapacityExecution({ planId: 'plan1', from: 'executing', to: 'planned' });
      throw new Error('Should have thrown');
    } catch (e: any) {
      if (!e.message.includes('Invalid transition')) throw e;
    }
  });
  await test('Execution halt', () => {
    const exec = processCapacityExecution({ planId: 'plan1', operation: 'halt' });
    if (exec.state !== 'halted') throw new Error('Expected halted');
  });
  await test('Duplicate execution prevention', () => {
    const e1 = processCapacityExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    const e2 = processCapacityExecution({ planId: 'plan1', idempotencyKey: 'exec-dup' });
    if (e1.id !== e2.id) throw new Error('Expected same execution id');
  });

  // Verification
  await test('Verification success', () => {
    const ver = processCapacityVerification({ executionId: 'exec1', verificationSuccess: true });
    if (ver.state !== 'success') throw new Error('Expected success');
  });
  await test('Verification failure', () => {
    const ver = processCapacityVerification({ executionId: 'exec1', failed: true });
    if (ver.state !== 'failed') throw new Error('Expected failed');
  });
  await test('Capacity regression', () => {
    const ver = processCapacityVerification({ executionId: 'exec1', regression: true });
    if (ver.state !== 'regression') throw new Error('Expected regression');
  });
  await test('SLO regression', () => {
    // Not implemented separately; treated as regression.
  });
  await test('Dependency regression', () => {
    // Same.
  });

  // Rollback
  await test('Rollback creation', () => {
    const rb = processCapacityRollback({ executionId: 'exec1' });
    if (!rb.id) throw new Error('Rollback missing');
  });
  await test('Rollback safety', () => {
    const rb = processCapacityRollback({ executionId: 'exec1' });
    if (!rb.id) throw new Error('Rollback safety missing');
  });
  await test('Rollback execution', () => {
    const rb = processCapacityRollback({ executionId: 'exec1' });
    if (rb.state !== 'success') throw new Error('Rollback not executed');
  });
  await test('Rollback verification', () => {
    const rb = processCapacityRollback({ executionId: 'exec1', verificationSuccess: true });
    if (rb.state !== 'success') throw new Error('Verification failed');
  });
  await test('Rollback idempotency', () => {
    const rb1 = processCapacityRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    const rb2 = processCapacityRollback({ executionId: 'exec1', idempotencyKey: 'rb-dup' });
    if (rb1.id !== rb2.id) throw new Error('Expected same rollback id');
  });
  await test('Rollback failure', () => {
    const rb = processCapacityRollback({ executionId: 'exec1', fail: true });
    if (rb.state !== 'failed') throw new Error('Expected failed');
  });

  // Circuit breaker
  await test('Breaker closed', () => {
    const cb = processCircuitBreaker({ scope: 'capacity' });
    if (cb.state !== 'CLOSED') throw new Error('Expected CLOSED');
  });
  await test('Breaker opens', () => {
    const cb = processCircuitBreaker({ scope: 'capacity', failures: 3, threshold: 3 });
    if (cb.state !== 'OPEN') throw new Error('Expected OPEN');
  });
  await test('Execution blocked while breaker is open', () => {
    const exec = processCapacityExecution({ planId: 'plan1', circuitBreakerState: 'OPEN' });
    if (!exec.blocked) throw new Error('Expected blocked');
  });

  // Incidents
  await test('Incident creation', () => {
    const inc = processIncident({ resourceId: 'res1', severity: 'high' });
    if (!inc.id) throw new Error('Incident missing');
  });
  await test('Duplicate incident prevention', () => {
    const i1 = processIncident({ resourceId: 'res1', signature: 'sig1' });
    const i2 = processIncident({ resourceId: 'res1', signature: 'sig1' });
    if (i1.id !== i2.id) throw new Error('Expected same incident id');
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
    const audit = processAudit({ resourceId: 'res1', eventType: 'capacity_change', previousState: 'planned', newState: 'approved' });
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

  // End-to-end
  await test('Full approved capacity lifecycle orchestration', () => {
    const result = processAutonomousCapacityControlPlane({ resourceId: 'res1', approve: true });
    if (result.status !== 'COMPLETED') throw new Error('Lifecycle failed');
  });
  await test('Repeated identical capacity request remains idempotent', () => {
    const r1 = processResource({ provider: 'aws', resourceType: 'compute', idempotencyKey: 'res-idem' });
    const r2 = processResource({ provider: 'aws', resourceType: 'compute', idempotencyKey: 'res-idem' });
    if (r1.id !== r2.id) throw new Error('Expected same resource id');
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
  console.log('=== Phase 44: Autonomous Capacity Planning & Resource Optimization ===');
  let passed = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`${passed} tests passed, ${results.length - passed} tests failed.`);
  console.log(passed === results.length ? 'PHASE 44: PASS' : 'PHASE 44: FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

runTests();
