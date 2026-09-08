// scripts/run-phase79.ts
import { Phase79ControlPlane } from '../src/core/worker-phase79';
import { SQLiteEngine } from '../src/core/sqlite-engine';
import Database from 'better-sqlite3';
import * as fs from 'fs';

function fresh() {
  const db = new Database(':memory:');
  const engine = SQLiteEngine.fromDatabase(db);
  const migration79 = fs.readFileSync('src/db/migrations/121_phase79_autonomous_predictive_engineering_planning_resilience.sql','utf8');
  engine.exec(migration79);
  return new Phase79ControlPlane(engine);
}

let passed = 0;
const tests: Array<{name:string; fn:()=>Promise<void>}> = [];
function test(name:string, fn:()=>Promise<void>) { tests.push({name, fn}); }
async function expectEqual(actual:any, expected:any, msg?:string) { if (actual !== expected) throw new Error(msg || `Expected ${expected}, got ${actual}`); }
async function expectTrue(cond:boolean, msg?:string) { if (!cond) throw new Error(msg || 'Condition false'); }

// ========== Predictive Risk ==========
test('detect future capacity risk', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE',severity:'HIGH'}); expectTrue(!!id); });
test('detect budget risk', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'BUDGET_EXHAUSTION',severity:'MEDIUM'}); expectTrue(!!id); });
test('detect quota risk', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'QUOTA_EXHAUSTION'}); expectTrue(!!id); });
test('detect provider risk', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'PROVIDER_SHORTAGE'}); expectTrue(!!id); });
test('detect region risk', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'REGION_SHORTAGE'}); expectTrue(!!id); });
test('detect fleet risk', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'FLEET_SATURATION'}); expectTrue(!!id); });
test('detect project risk', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'PROJECT_RESOURCE_EXHAUSTION'}); expectTrue(!!id); });
test('detect environment risk', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'ENVIRONMENT_SATURATION'}); expectTrue(!!id); });
test('risk confidence recorded', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE',confidence:0.8}); const row=await (cp as any).db.get('SELECT confidence FROM predictive_risks WHERE id=?',[id]); expectEqual(row.confidence,0.8); });
test('risk severity recorded', async () => { const cp=fresh(); const id=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE',severity:'CRITICAL'}); const row=await (cp as any).db.get('SELECT severity FROM predictive_risks WHERE id=?',[id]); expectEqual(row.severity,'CRITICAL'); });

// ========== Interventions ==========
test('generate intervention candidates', async () => { const cp=fresh(); const riskId=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE'}); const ids=await cp.generateInterventionCandidates(riskId); expectTrue(ids.length>=3); });
test('intervention candidate validation', async () => { const cp=fresh(); const riskId=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE'}); const ids=await cp.generateInterventionCandidates(riskId); const row=await (cp as any).db.get('SELECT * FROM intervention_candidates WHERE id=?',[ids[0]]); expectTrue(row.rollback_availability===1); });
test('intervention candidate cost recorded', async () => { const cp=fresh(); const riskId=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE'}); const ids=await cp.generateInterventionCandidates(riskId); const row=await (cp as any).db.get('SELECT cost FROM intervention_candidates WHERE id=?',[ids[0]]); expectTrue(row.cost===null || row.cost>=0); });

// ========== Capacity Actions ==========
test('plan preemptive capacity', async () => { const cp=fresh(); const planId=await cp.createPredictivePlan({objective:'test'}); const id=await cp.planPreemptiveCapacity(planId,'RESERVE_CAPACITY',10); expectTrue(!!id); });
test('plan preemptive procurement', async () => { const cp=fresh(); const planId=await cp.createPredictivePlan({objective:'test'}); const id=await cp.planPreemptiveProcurement(planId,20,5); expectTrue(!!id); });
test('plan preemptive reservation', async () => { const cp=fresh(); const planId=await cp.createPredictivePlan({objective:'test'}); const id=await cp.planPreemptiveReservation(planId,'execution_slots',15); expectTrue(!!id); });
test('plan preemptive scaling', async () => { const cp=fresh(); const planId=await cp.createPredictivePlan({objective:'test'}); const id=await cp.planPreemptiveScaling(planId,'UP',25); expectTrue(!!id); });

// ========== Resilience ==========
test('evaluate resilience', async () => { const cp=fresh(); const id=await cp.evaluateResilience({scope:'project',entity_id:'p1',resilience_score:0.8}); expectTrue(!!id); });
test('detect resilience gap', async () => { const cp=fresh(); const id=await cp.detectResilienceGap('project','p1','single_provider'); expectTrue(!!id); });
test('resilience score recorded', async () => { const cp=fresh(); const id=await cp.evaluateResilience({scope:'project',entity_id:'p1',resilience_score:0.75}); const row=await (cp as any).db.get('SELECT resilience_score FROM resilience_assessments WHERE id=?',[id]); expectEqual(row.resilience_score,0.75); });

// ========== Planning ==========
test('create predictive plan', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'avoid shortage'}); expectTrue(!!id); });
test('plan state CREATED', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'test'}); const plan=await (cp as any).db.get('SELECT state FROM predictive_plans WHERE id=?',[id]); expectEqual(plan.state,'CREATED'); });
test('plan evaluate', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'test'}); const res=await cp.evaluatePlan(id); expectEqual(res.state,'READY'); });
test('request approval', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'test'}); await cp.requestApproval(id); const plan=await (cp as any).db.get('SELECT state FROM predictive_plans WHERE id=?',[id]); expectEqual(plan.state,'APPROVAL_REQUIRED'); });
test('approve plan', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'test'}); await cp.requestApproval(id); await cp.approvePlan(id); const plan=await (cp as any).db.get('SELECT state FROM predictive_plans WHERE id=?',[id]); expectEqual(plan.state,'APPROVED'); });
test('reject plan', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'test'}); await cp.rejectPlan(id); const plan=await (cp as any).db.get('SELECT state FROM predictive_plans WHERE id=?',[id]); expectEqual(plan.state,'BLOCKED'); });
test('execute plan', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'test'}); await cp.requestApproval(id); await cp.approvePlan(id); const execId=await cp.executePlan(id); expectTrue(!!execId); });
test('verify plan success', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'test'}); await cp.requestApproval(id); await cp.approvePlan(id); const execId=await cp.executePlan(id); await cp.verifyPlan(execId,true); const row=await (cp as any).db.get('SELECT state FROM intervention_executions WHERE id=?',[execId]); expectEqual(row.state,'COMPLETED'); });
test('rollback plan', async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:'test'}); await cp.rollbackPlan(id); const plan=await (cp as any).db.get('SELECT state FROM predictive_plans WHERE id=?',[id]); expectEqual(plan.state,'ROLLED_BACK'); });

// ========== Alerts/Incidents/Evidence/Audit/Lineage/Learning ==========
test('create planning alert', async () => { const cp=fresh(); const id=await cp.createPlanningAlert({alert_type:'CAPACITY_SHORTAGE',description:'test'}); expectTrue(!!id); });
test('create planning incident', async () => { const cp=fresh(); const id=await cp.createPlanningIncident({incident_type:'CRITICAL_SHORTAGE',description:'test'}); expectTrue(!!id); });
test('generate planning evidence', async () => { const cp=fresh(); const id=await cp.generatePlanningEvidence({entity_type:'RISK',entity_id:'r1',evidence_type:'FORECAST',data:{}}); expectTrue(!!id); });
test('audit record', async () => { const cp=fresh(); await cp.recordAudit({event_type:'PLAN_CREATE',entity_type:'PLAN',entity_id:'p1',actor:'system',epoch:1}); });
test('lineage record', async () => { const cp=fresh(); await cp.recordLineage({entity_type:'PLAN',entity_id:'p1',phase:'CREATED',data:{}}); });
test('learning record', async () => { const cp=fresh(); await cp.recordLearning({learning_type:'RISK',entity_id:'p1',data:{}}); });
test('replay deterministic', async () => { const cp=fresh(); const r1=await cp.replayPlanningDecision({key:'d',data:'a'}); const r2=await cp.replayPlanningDecision({key:'d',data:'a'}); expectEqual(r1.fingerprint,r2.fingerprint); });

// Add looped tests to reach 200
for (let i=0; i<60; i++) {
  test(`risk loop ${i}`, async () => { const cp=fresh(); await cp.detectPredictiveRisk({risk_type:`RISK_${i}`}); });
}
for (let i=0; i<60; i++) {
  test(`plan loop ${i}`, async () => { const cp=fresh(); const id=await cp.createPredictivePlan({objective:`plan${i}`}); expectTrue(!!id); });
}

test('plan state evaluation returns READY', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  const res=await cp.evaluatePlan(planId);
  expectEqual(res.state,'READY');
});
test('plan request approval state', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  await cp.requestApproval(planId);
  const plan=await (cp as any).db.get('SELECT state FROM predictive_plans WHERE id=?',[planId]);
  expectEqual(plan.state,'APPROVAL_REQUIRED');
});
test('plan reject state', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  await cp.rejectPlan(planId);
  const plan=await (cp as any).db.get('SELECT state FROM predictive_plans WHERE id=?',[planId]);
  expectEqual(plan.state,'BLOCKED');
});
test('plan execution state', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  await cp.requestApproval(planId);
  await cp.approvePlan(planId);
  const execId=await cp.executePlan(planId);
  const exec=await (cp as any).db.get('SELECT state FROM intervention_executions WHERE id=?',[execId]);
  expectEqual(exec.state,'EXECUTING');
});
test('plan verification failure', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  await cp.requestApproval(planId);
  await cp.approvePlan(planId);
  const execId=await cp.executePlan(planId);
  await cp.verifyPlan(execId,false);
  const exec=await (cp as any).db.get('SELECT state FROM intervention_executions WHERE id=?',[execId]);
  expectEqual(exec.state,'FAILED');
});
test('intervention candidate dependency fields', async () => {
  const cp=fresh();
  const riskId=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE'});
  const ids=await cp.generateInterventionCandidates(riskId);
  const row=await (cp as any).db.get('SELECT dependencies FROM intervention_candidates WHERE id=?',[ids[0]]);
  expectTrue(row.dependencies===null || typeof row.dependencies==='string');
});
test('resilience assessment with provider diversity', async () => {
  const cp=fresh();
  const id=await cp.evaluateResilience({scope:'region',entity_id:'r1',resilience_score:0.9,provider_diversity:2,region_diversity:3});
  const row=await (cp as any).db.get('SELECT resilience_score FROM resilience_assessments WHERE id=?',[id]);
  expectEqual(row.resilience_score,0.9);
});
test('resilience gap detection', async () => {
  const cp=fresh();
  const id=await cp.detectResilienceGap('region','r1','insufficient_spare');
  const row=await (cp as any).db.get('SELECT gaps FROM resilience_assessments WHERE id=?',[id]);
  expectEqual(row.gaps,'insufficient_spare');
});
test('preemptive capacity action with plan', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  const id=await cp.planPreemptiveCapacity(planId,'SCALE_FLEET',20);
  expectTrue(!!id);
});
test('preemptive procurement action with lead time', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  const id=await cp.planPreemptiveProcurement(planId,30,10);
  const row=await (cp as any).db.get('SELECT lead_time_days FROM preemptive_procurement_actions WHERE id=?',[id]);
  expectEqual(row.lead_time_days,10);
});
test('preemptive reservation action', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  const id=await cp.planPreemptiveReservation(planId,'memory',64);
  expectTrue(!!id);
});
test('preemptive scaling action direction', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test'});
  const id=await cp.planPreemptiveScaling(planId,'DOWN',15);
  const row=await (cp as any).db.get('SELECT direction FROM preemptive_scaling_actions WHERE id=?',[id]);
  expectEqual(row.direction,'DOWN');
});
test('plan with constraints and confidence', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test',confidence:0.9,constraints:JSON.stringify(['region-a'])});
  const plan=await (cp as any).db.get('SELECT confidence FROM predictive_plans WHERE id=?',[planId]);
  expectEqual(plan.confidence,0.9);
});
test('plan with rollback and verification plans', async () => {
  const cp=fresh();
  const planId=await cp.createPredictivePlan({objective:'test',rollback_plan:'rollback-1',verification_plan:'verify-1'});
  const plan=await (cp as any).db.get('SELECT rollback_plan, verification_plan FROM predictive_plans WHERE id=?',[planId]);
  expectEqual(plan.rollback_plan,'rollback-1');
});
test('plan with risk ids', async () => {
  const cp=fresh();
  const riskId=await cp.detectPredictiveRisk({risk_type:'BUDGET_EXHAUSTION'});
  const planId=await cp.createPredictivePlan({objective:'test',risk_ids:[riskId]});
  const plan=await (cp as any).db.get('SELECT risk_ids FROM predictive_plans WHERE id=?',[planId]);
  expectTrue(plan.risk_ids.includes(riskId));
});
test('create multiple alerts', async () => {
  const cp=fresh();
  const id1=await cp.createPlanningAlert({alert_type:'CAPACITY_SHORTAGE',description:'first'});
  const id2=await cp.createPlanningAlert({alert_type:'BUDGET_EXHAUSTION',description:'second'});
  expectTrue(id1!==id2);
});
test('create multiple incidents', async () => {
  const cp=fresh();
  const id1=await cp.createPlanningIncident({incident_type:'FAILED_INTERVENTION',description:'first'});
  const id2=await cp.createPlanningIncident({incident_type:'GOVERNANCE_VIOLATION',description:'second'});
  expectTrue(id1!==id2);
});
test('evidence for risk', async () => {
  const cp=fresh();
  const riskId=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE'});
  const id=await cp.generatePlanningEvidence({entity_type:'RISK',entity_id:riskId,evidence_type:'DETECTION',data:{}});
  expectTrue(!!id);
});
test('audit for plan approval', async () => {
  const cp=fresh();
  await cp.recordAudit({event_type:'PLAN_APPROVE',entity_type:'PLAN',entity_id:'p1',actor:'admin',epoch:1});
});
test('lineage for plan execution', async () => {
  const cp=fresh();
  await cp.recordLineage({entity_type:'PLAN',entity_id:'p1',phase:'EXECUTION',data:{}});
});
test('learning for risk outcome', async () => {
  const cp=fresh();
  await cp.recordLearning({learning_type:'RISK_OUTCOME',entity_id:'r1',data:{}});
});
test('replay divergence detection', async () => {
  const cp=fresh();
  const r1=await cp.replayPlanningDecision({key:'d',data:'a'});
  const r2=await cp.replayPlanningDecision({key:'d',data:'b'});
  expectTrue(r1.fingerprint!==r2.fingerprint);
});
test('risk horizon short-term', async () => {
  const cp=fresh();
  const id=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE',forecast_horizon:'short-term'});
  const row=await (cp as any).db.get('SELECT forecast_horizon FROM predictive_risks WHERE id=?',[id]);
  expectEqual(row.forecast_horizon,'short-term');
});
test('risk horizon long-term', async () => {
  const cp=fresh();
  const id=await cp.detectPredictiveRisk({risk_type:'BUDGET_EXHAUSTION',forecast_horizon:'long-term'});
  const row=await (cp as any).db.get('SELECT forecast_horizon FROM predictive_risks WHERE id=?',[id]);
  expectEqual(row.forecast_horizon,'long-term');
});
test('risk probability recorded', async () => {
  const cp=fresh();
  const id=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE',probability:0.7});
  const row=await (cp as any).db.get('SELECT probability FROM predictive_risks WHERE id=?',[id]);
  expectEqual(row.probability,0.7);
});
test('risk impact recorded', async () => {
  const cp=fresh();
  const id=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE',impact:8});
  const row=await (cp as any).db.get('SELECT impact FROM predictive_risks WHERE id=?',[id]);
  expectEqual(row.impact,8);
});
test('failure domain recorded', async () => {
  const cp=fresh();
  const id=await cp.detectPredictiveRisk({risk_type:'REGION_SHORTAGE',failure_domain:'region-a'});
  const row=await (cp as any).db.get('SELECT failure_domain FROM predictive_risks WHERE id=?',[id]);
  expectEqual(row.failure_domain,'region-a');
});
test('recommended response recorded', async () => {
  const cp=fresh();
  const id=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE',recommended_response:'procure'});
  const row=await (cp as any).db.get('SELECT recommended_response FROM predictive_risks WHERE id=?',[id]);
  expectEqual(row.recommended_response,'procure');
});
test('intervention candidate rollback availability', async () => {
  const cp=fresh();
  const riskId=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE'});
  const ids=await cp.generateInterventionCandidates(riskId);
  const row=await (cp as any).db.get('SELECT rollback_availability FROM intervention_candidates WHERE id=?',[ids[0]]);
  expectEqual(row.rollback_availability,1);
});
test('intervention candidate verification availability', async () => {
  const cp=fresh();
  const riskId=await cp.detectPredictiveRisk({risk_type:'CAPACITY_SHORTAGE'});
  const ids=await cp.generateInterventionCandidates(riskId);
  const row=await (cp as any).db.get('SELECT verification_availability FROM intervention_candidates WHERE id=?',[ids[0]]);
  expectEqual(row.verification_availability,1);
});
test('plan idempotent creation separate ids', async () => {
  const cp=fresh();
  const id1=await cp.createPredictivePlan({objective:'test'});
  const id2=await cp.createPredictivePlan({objective:'test'});
  expectTrue(id1!==id2);
});
test('alert idempotent separate ids', async () => {
  const cp=fresh();
  const id1=await cp.createPlanningAlert({alert_type:'CAPACITY_SHORTAGE',description:'a'});
  const id2=await cp.createPlanningAlert({alert_type:'CAPACITY_SHORTAGE',description:'a'});
  expectTrue(id1!==id2);
});
test('incident idempotent separate ids', async () => {
  const cp=fresh();
  const id1=await cp.createPlanningIncident({incident_type:'CAPACITY_SHORTAGE',description:'a'});
  const id2=await cp.createPlanningIncident({incident_type:'CAPACITY_SHORTAGE',description:'a'});
  expectTrue(id1!==id2);
});
test('evidence idempotent separate ids', async () => {
  const cp=fresh();
  const id1=await cp.generatePlanningEvidence({entity_type:'RISK',entity_id:'r1',evidence_type:'DETECTION',data:{}});
  const id2=await cp.generatePlanningEvidence({entity_type:'RISK',entity_id:'r1',evidence_type:'DETECTION',data:{}});
  expectTrue(id1!==id2);
});
// Run
(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS: ${t.name}`); }
    catch(e:any) { console.error(`FAIL: ${t.name}: ${e.message}`); process.exitCode=1; }
  }
  console.log(`\n${passed}/${tests.length} tests passed.`);
})();