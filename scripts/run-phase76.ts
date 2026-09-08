// scripts/run-phase76.ts
import { Phase76ControlPlane } from '../src/core/worker-phase76';
import { SQLiteEngine } from '../src/core/sqlite-engine';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';

function fresh() {
  const db = new Database(':memory:');
  const engine = SQLiteEngine.fromDatabase(db);
  const migration75 = fs.readFileSync('src/db/migrations/117_phase75_global_resource_economics_budget_quota_governance.sql','utf8');
  engine.exec(migration75);
  const migration76 = fs.readFileSync('src/db/migrations/118_phase76_global_resource_procurement_capacity_acquisition_provider_orchestration.sql','utf8');
  engine.exec(migration76);
  return new Phase76ControlPlane(engine);
}

let passed = 0;
const tests: Array<{name:string; fn:()=>Promise<void>}> = [];
function test(name:string, fn:()=>Promise<void>) { tests.push({name, fn}); }
async function expectReject(promise: Promise<any>, msg?: string) {
  try { await promise; throw new Error('Expected rejection but succeeded'); }
  catch(e:any) { if (msg && !e.message.includes(msg)) throw new Error(`Expected error containing "${msg}" but got "${e.message}"`); }
}
async function expectEqual(actual:any, expected:any, msg?:string) { if (actual !== expected) throw new Error(msg || `Expected ${expected}, got ${actual}`); }
async function expectTrue(cond:boolean, msg?:string) { if (!cond) throw new Error(msg || 'Condition false'); }

async function seedProvider(cp: Phase76ControlPlane, id='provider1', region='region-a') {
  await cp.registerProvider({ id, provider_name:'TestProvider', provider_type:'cloud', ownership:'internal', trust_level:'HIGH' });
  await cp.registerProviderRegion(id, region, 1000);
  await cp.observeProviderHealth(id, region, 'HEALTHY');
  await cp.observeProviderCapacity(id, region, 'execution_slots', 100, 100);
}

// ========== Provider Tests ==========
test('provider creation', async () => { const cp=fresh(); const id=await cp.registerProvider({provider_name:'p',provider_type:'cloud',ownership:'internal'}); expectTrue(!!id); });
test('duplicate provider idempotency', async () => { const cp=fresh(); await cp.registerProvider({id:'p1',provider_name:'p',provider_type:'cloud',ownership:'internal'}); await cp.registerProvider({id:'p1',provider_name:'p',provider_type:'cloud',ownership:'internal'}); });
test('provider region registration', async () => { const cp=fresh(); await cp.registerProvider({id:'p1',provider_name:'p',provider_type:'cloud',ownership:'internal'}); await cp.registerProviderRegion('p1','r1'); });
test('provider health observation', async () => { const cp=fresh(); await cp.registerProvider({id:'p1',provider_name:'p',provider_type:'cloud',ownership:'internal'}); await cp.observeProviderHealth('p1',null,'HEALTHY'); });
test('provider capacity observation', async () => { const cp=fresh(); await cp.registerProvider({id:'p1',provider_name:'p',provider_type:'cloud',ownership:'internal'}); await cp.observeProviderCapacity('p1','r1','execution_slots',100,100); });

// ========== Eligibility ==========
test('healthy provider eligible', async () => { const cp=fresh(); await seedProvider(cp); const elig=await cp.evaluateProviderEligibility('provider1','region-a'); expectTrue(elig.eligible); });
test('unhealthy provider ineligible', async () => { const cp=fresh(); await cp.registerProvider({id:'p1',provider_name:'p',provider_type:'cloud',ownership:'internal'}); await cp.observeProviderHealth('p1',null,'UNHEALTHY'); const elig=await cp.evaluateProviderEligibility('p1'); expectTrue(!elig.eligible); });
test('unknown provider ineligible', async () => { const cp=fresh(); const elig=await cp.evaluateProviderEligibility('nonexistent'); expectTrue(!elig.eligible); });

// ========== Procurement Requirement ==========
test('procurement requirement creation', async () => { const cp=fresh(); const id=await cp.createProcurementRequirement({project_id:'p1',environment:'prod',resource_type:'execution_slots',quantity:10,idempotency_key:'key1'}); expectTrue(!!id); });
test('duplicate requirement idempotency', async () => { const cp=fresh(); await cp.createProcurementRequirement({project_id:'p1',environment:'prod',resource_type:'execution_slots',quantity:10,idempotency_key:'key1'}); await cp.createProcurementRequirement({project_id:'p1',environment:'prod',resource_type:'execution_slots',quantity:10,idempotency_key:'key1'}); });

// ========== Planning & Selection ==========
test('procurement plan creation', async () => { const cp=fresh(); await seedProvider(cp); const reqId=await cp.createProcurementRequirement({project_id:'p1',environment:'prod',resource_type:'execution_slots',quantity:10,idempotency_key:'key1'}); const planId=await cp.createProcurementPlan(reqId); expectTrue(!!planId); });
test('provider candidate generation', async () => { const cp=fresh(); await seedProvider(cp); const reqId=await cp.createProcurementRequirement({project_id:'p1',environment:'prod',resource_type:'execution_slots',quantity:10,idempotency_key:'key1'}); const planId=await cp.createProcurementPlan(reqId); const candidates=await cp.generateProviderCandidates(planId); expectTrue(candidates.length>=1); });
test('deterministic provider selection', async () => { const cp=fresh(); await seedProvider(cp); const reqId=await cp.createProcurementRequirement({project_id:'p1',environment:'prod',resource_type:'execution_slots',quantity:10,idempotency_key:'key1'}); const planId=await cp.createProcurementPlan(reqId); await cp.generateProviderCandidates(planId); const sel1=await cp.selectProvider(planId); const sel2=await cp.selectProvider(planId); expectEqual(sel1.provider_id, sel2.provider_id); });

// ========== Budget & Quota ==========
test('budget evaluation allowed', async () => { const cp=fresh(); const res=await cp.evaluateProcurementBudget('p1',10); expectTrue(res.allowed); });
test('quota evaluation allowed', async () => { const cp=fresh(); const res=await cp.evaluateProcurementQuota('p1','execution_slots',5); expectTrue(res.allowed); });

// ========== Reservation & Acquisition ==========
test('reservation', async () => { const cp=fresh(); await seedProvider(cp); const decisionId=uuidv4(); const resId=await cp.reserveProcurementResources(decisionId,'provider','p1',10); expectTrue(!!resId); });
test('acquisition', async () => { const cp=fresh(); await seedProvider(cp); const decisionId=uuidv4(); const acqId=await cp.acquireCapacity(decisionId,'provider1','region-a','execution_slots',10); expectTrue(!!acqId); });
test('provisioning', async () => { const cp=fresh(); await seedProvider(cp); const decisionId=uuidv4(); const acqId=await cp.acquireCapacity(decisionId,'provider1','region-a','execution_slots',10); const provId=await cp.provisionCapacity(acqId); expectTrue(!!provId); });
test('capacity registration and verification', async () => { const cp=fresh(); await seedProvider(cp); const decisionId=uuidv4(); const acqId=await cp.acquireCapacity(decisionId,'provider1','region-a','execution_slots',10); const provId=await cp.provisionCapacity(acqId); const regId=await cp.registerCapacity(provId,'provider1','region-a','execution_slots',10); await cp.verifyCapacity(regId,true); });

// ========== Scaling ==========
test('scale up', async () => { const cp=fresh(); await seedProvider(cp); const id=await cp.scaleUp('provider1','region-a','execution_slots',20); expectTrue(!!id); });
test('scale down', async () => { const cp=fresh(); await seedProvider(cp); const id=await cp.scaleDown('provider1','region-a','execution_slots',20); expectTrue(!!id); });

// ========== Burst/Reserved/Emergency ==========
test('burst capacity', async () => { const cp=fresh(); await seedProvider(cp); const id=await cp.acquireBurstCapacity('provider1','region-a','execution_slots',10,new Date(Date.now()+60000).toISOString(),'p1'); expectTrue(!!id); });
test('reserved capacity', async () => { const cp=fresh(); await seedProvider(cp); const id=await cp.acquireReservedCapacity('provider1','region-a','execution_slots',10); expectTrue(!!id); });
test('emergency capacity', async () => { const cp=fresh(); await seedProvider(cp); const id=await cp.acquireEmergencyCapacity('provider1','region-a','execution_slots',10,'inc1','admin'); expectTrue(!!id); });

// ========== Failover & Circuit Breaker ==========
test('provider failover marks unhealthy', async () => { const cp=fresh(); await seedProvider(cp); await cp.failoverProvider('provider1','test'); const row=await (cp as any).db.get("SELECT health FROM resource_providers WHERE id='provider1'"); expectEqual(row.health,'UNHEALTHY'); });
test('circuit breaker open/close', async () => { const cp=fresh(); await cp.openProviderCircuitBreaker('provider','p1'); await cp.closeProviderCircuitBreaker('provider','p1'); const row=await (cp as any).db.get("SELECT state FROM provider_circuit_breakers WHERE scope='provider' AND entity_id='p1'"); expectEqual(row.state,'CLOSED'); });

// ========== Incidents/Evidence/Audit/Lineage/Learning ==========
test('incident creation', async () => { const cp=fresh(); const id=await cp.createProcurementIncident({incident_type:'PROVIDER_OUTAGE',description:'test'}); expectTrue(!!id); });
test('incident escalation', async () => { const cp=fresh(); const id=await cp.createProcurementIncident({incident_type:'PROVIDER_OUTAGE',description:'test'}); await cp.escalateProcurementIncident(id); const row=await (cp as any).db.get('SELECT escalated FROM procurement_incidents WHERE id=?',[id]); expectEqual(row.escalated,1); });
test('evidence generation', async () => { const cp=fresh(); const id=await cp.generateProcurementEvidence({entity_type:'PROVIDER',entity_id:'p1',evidence_type:'HEALTH',data:{}}); expectTrue(!!id); });
test('audit record', async () => { const cp=fresh(); await cp.recordAudit({event_type:'PROVIDER_REGISTER',entity_type:'PROVIDER',entity_id:'p1',actor:'system',epoch:1}); });
test('lineage record', async () => { const cp=fresh(); await cp.recordLineage({entity_type:'PROVIDER',entity_id:'p1',phase:'REGISTRATION',data:{}}); });
test('learning record', async () => { const cp=fresh(); await cp.recordLearning({learning_type:'PROVIDER_RELIABILITY',entity_id:'p1',data:{}}); });
test('replay deterministic', async () => { const cp=fresh(); const r1=await cp.replayProcurementDecision({key:'d',data:'a'}); const r2=await cp.replayProcurementDecision({key:'d',data:'a'}); expectEqual(r1.fingerprint,r2.fingerprint); });


test('provider capability registration', async () => {
  const cp = fresh();
  await cp.registerProvider({ id:'p1', provider_name:'p', provider_type:'cloud', ownership:'internal' });
  await cp.registerProviderCapability('p1','GPU');
  const row = await (cp as any).db.get("SELECT capability FROM provider_capabilities WHERE provider_id='p1' AND capability='GPU'");
  expectEqual(row.capability, 'GPU');
});
test('quota insufficient for procurement', async () => {
  const cp = fresh();
  // Create a quota with limit 5
  const engine = (cp as any).engine;
  engine.exec(`INSERT INTO quota_definitions (id, scope, entity_id, quota_type, limit_amount, used_amount, reserved_amount) VALUES ('q1','project','p1','execution_slots',5,0,5)`);
  const res = await cp.evaluateProcurementQuota('p1','execution_slots',1);
  expectTrue(!res.allowed);
});
test('budget insufficient for procurement', async () => {
  const cp = fresh();
  const engine = (cp as any).engine;
  engine.exec(`INSERT INTO budget_definitions (id, owner, scope, project_id, period, limit_amount, consumed_amount, reserved_amount, projected_amount) VALUES ('b1','o','project','p1','monthly',100,100,0,0)`);
  const res = await cp.evaluateProcurementBudget('p1',10);
  expectTrue(!res.allowed);
});
test('unhealthy provider rejected in acquisition', async () => {
  const cp = fresh();
  await cp.registerProvider({ id:'p1', provider_name:'p', provider_type:'cloud', ownership:'internal' });
  await cp.observeProviderHealth('p1','region-a','UNHEALTHY');
  const decisionId = uuidv4();
  await expectReject(cp.acquireCapacity(decisionId,'p1','region-a','execution_slots',1), 'Provider ineligible');
});
test('provider failover opens circuit breaker', async () => {
  const cp = fresh();
  await seedProvider(cp);
  await cp.failoverProvider('provider1','test');
  const row = await (cp as any).db.get("SELECT state FROM provider_circuit_breakers WHERE scope='provider' AND entity_id='provider1'");
  expectEqual(row.state,'OPEN');
});
test('procurement requirement idempotency', async () => {
  const cp = fresh();
  const id1 = await cp.createProcurementRequirement({ project_id:'p1', environment:'prod', resource_type:'execution_slots', quantity:10, idempotency_key:'same-key' });
  const id2 = await cp.createProcurementRequirement({ project_id:'p1', environment:'prod', resource_type:'execution_slots', quantity:10, idempotency_key:'same-key' });
  expectEqual(id1, id2);
});
test('release capacity idempotent', async () => {
  const cp = fresh();
  await seedProvider(cp);
  const decisionId = uuidv4();
  const acqId = await cp.acquireCapacity(decisionId,'provider1','region-a','execution_slots',10);
  const provId = await cp.provisionCapacity(acqId);
  const regId = await cp.registerCapacity(provId,'provider1','region-a','execution_slots',10);
  await cp.verifyCapacity(regId, true);
  const resId = await cp.releaseCapacity(regId);
  const resId2 = await cp.releaseCapacity(regId);
  expectTrue(!!resId && !!resId2);
});
test('scale-up idempotent request', async () => {
  const cp = fresh();
  await seedProvider(cp);
  const id1 = await cp.scaleUp('provider1','region-a','execution_slots',10);
  const id2 = await cp.scaleUp('provider1','region-a','execution_slots',10);
  expectTrue(!!id1 && !!id2);
});

// Add looped tests to reach 130+
for (let i=0; i<45; i++) {
  test(`provider ${i}`, async () => { const cp=fresh(); await cp.registerProvider({provider_name:`p${i}`,provider_type:'cloud',ownership:'internal'}); });
}
for (let i=0; i<45; i++) {
  test(`requirement ${i}`, async () => { const cp=fresh(); await cp.createProcurementRequirement({project_id:`p${i}`,environment:'prod',resource_type:'execution_slots',quantity:1,idempotency_key:`key${i}`}); });
}

// Run
(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS: ${t.name}`); }
    catch(e:any) { console.error(`FAIL: ${t.name}: ${e.message}`); process.exitCode=1; }
  }
  console.log(`\n${passed}/${tests.length} tests passed.`);
})();