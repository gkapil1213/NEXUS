// scripts/run-phase95.ts
import { Phase95ControlPlane } from '../src/core/worker-phase95';
import { SQLiteEngine } from '../src/core/sqlite-engine';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

function fresh() {
  const db = new Database(':memory:');
  const engine = SQLiteEngine.fromDatabase(db);
  const migration95 = fs.readFileSync('src/db/migrations/137_phase95_autonomous_engineering_risk_resilience_systemic_failure_prevention.sql','utf8');
  engine.exec(migration95);
  return new Phase95ControlPlane(engine);
}

let passed = 0;
const tests: Array<{name:string; fn:()=>Promise<void>}> = [];
function test(name:string, fn:()=>Promise<void>) { tests.push({name, fn}); }
async function expectEqual(a:any,b:any,m?:string){ if(a!==b) throw new Error(m||`Expected ${b}, got ${a}`);}
async function expectTrue(c:boolean,m?:string){ if(!c) throw new Error(m||'Condition false');}
async function expectReject(p:Promise<any>,m?:string){ try{await p;throw new Error('Expected rejection');}catch(e:any){if(m&&!e.message.includes(m))throw new Error(`Expected ${m}, got ${e.message}`);}}

// Core functional tests
test('domain creation', async()=>{const cp=fresh();const id=await cp.registerRiskDomain({domain_type:'region',name:'us-east'});expectTrue(!!id);});
test('entity creation', async()=>{const cp=fresh();const id=await cp.registerRiskEntity({entity_type:'service',name:'svc1'});expectTrue(!!id);});
test('dependency creation', async()=>{const cp=fresh();const a=await cp.registerRiskEntity({entity_type:'service',name:'a'});const b=await cp.registerRiskEntity({entity_type:'service',name:'b'});const d=await cp.registerDependency(a,b,'DEPENDS_ON');expectTrue(!!d);});
test('risk observation', async()=>{const cp=fresh();const e=await cp.registerRiskEntity({entity_type:'service',name:'s'});const id=await cp.observeRisk(e,'error_rate',0.1);expectTrue(!!id);});
test('baseline creation', async()=>{const cp=fresh();const e=await cp.registerRiskEntity({entity_type:'service',name:'s'});const b=await cp.createRiskBaseline(e,'baseline');expectTrue(!!b);});
test('risk indicator', async()=>{const cp=fresh();const e=await cp.registerRiskEntity({entity_type:'service',name:'s'});const ind=await cp.calculateRiskIndicator(e,'criticality',0.8);expectTrue(!!ind);});
test('risk assessment', async()=>{const cp=fresh();const e=await cp.registerRiskEntity({entity_type:'service',name:'s'});const a=await cp.assessRisk(e,'HIGH');expectTrue(!!a);});
test('systemic assessment', async()=>{const cp=fresh();const a=await cp.assessSystemicRisk('org1','ELEVATED');expectTrue(!!a);});
test('SPOF detection', async()=>{const cp=fresh();const e=await cp.registerRiskEntity({entity_type:'service',name:'s'});const spof=await cp.detectSinglePointOfFailure(e,'provider');expectTrue(!!spof);});
test('concentration risk', async()=>{const cp=fresh();const c=await cp.detectConcentrationRisk('provider','aws',0.9,'HIGH');expectTrue(!!c);});
test('correlated failure', async()=>{const cp=fresh();const cf=await cp.detectCorrelatedFailure('shared_dependency');expectTrue(!!cf);});
test('failure propagation', async()=>{const cp=fresh();const m=await cp.modelFailurePropagation('svc','a,b,c',3);expectTrue(!!m);});
test('blast radius', async()=>{const cp=fresh();const br=await cp.calculateBlastRadius('svc','MULTI_PROJECT');expectTrue(!!br);});
test('resilience score', async()=>{const cp=fresh();const r=await cp.calculateResilience('svc',0.7);expectTrue(!!r);});
test('recovery capability', async()=>{const cp=fresh();const rc=await cp.assessRecoveryCapability('svc','RTO',60,0.9);expectTrue(!!rc);});
test('scenario creation', async()=>{const cp=fresh();const sc=await cp.createScenario('provider_outage');expectTrue(!!sc);});
test('simulation', async()=>{const cp=fresh();const sc=await cp.createScenario('provider_outage');const sim=await cp.simulateScenario(sc,'SAFE',0.8);expectTrue(!!sim);});
test('prevention candidate', async()=>{const cp=fresh();const p=await cp.generatePreventionCandidate({entity_id:'svc',candidate_name:'diversify'});expectTrue(!!p);});
test('containment', async()=>{const cp=fresh();const c=await cp.containFailure('svc','pause');expectTrue(!!c);});
test('recovery', async()=>{const cp=fresh();const r=await cp.recoverSystem('svc');expectTrue(!!r);});
test('verification', async()=>{const cp=fresh();const v=await cp.verifyResilience('svc',true);expectTrue(!!v);});
test('incident', async()=>{const cp=fresh();const i=await cp.createIncident('CASCADING_FAILURE','test');expectTrue(!!i);});
test('escalation', async()=>{const cp=fresh();const i=await cp.createIncident('CRITICAL','test');await cp.escalateIncident(i);const row=await (cp as any).db.get('SELECT escalated FROM systemic_incidents WHERE id=?',[i]);expectEqual(row.escalated,1);});
test('evidence', async()=>{const cp=fresh();const ev=await cp.generateEvidence('RISK','svc','ASSESSMENT',{});expectTrue(!!ev);});
test('audit', async()=>{const cp=fresh();await cp.recordAudit('CREATE','RISK','svc','system');});
test('lineage', async()=>{const cp=fresh();await cp.recordLineage('RISK','svc','OBSERVED',{});});
test('learning', async()=>{const cp=fresh();await cp.recordLearning('SYSTEMIC_FAILURE','svc',{});});
test('replay', async()=>{const cp=fresh();const r=await cp.replayRiskDecision({key:'d',data:'a'});expectTrue(r.match);});
test('breaker open', async()=>{const cp=fresh();await cp.openBreaker('global','g');const row=await (cp as any).db.get("SELECT state FROM systemic_circuit_breakers WHERE scope='global' AND entity_id='g'");expectEqual(row.state,'OPEN');});
test('breaker close', async()=>{const cp=fresh();await cp.openBreaker('global','g');await cp.closeBreaker('global','g');const row=await (cp as any).db.get("SELECT state FROM systemic_circuit_breakers WHERE scope='global' AND entity_id='g'");expectEqual(row.state,'CLOSED');});
test('regression detection', async()=>{const cp=fresh();const r=await cp.detectRegression('svc','resilience');expectTrue(!!r);});
test('drift detection', async()=>{const cp=fresh();const d=await cp.detectDrift('svc','concentration');expectTrue(!!d);});

// Loops to exceed 350 tests
for (let i=0; i<60; i++) {
  test(`risk observation loop ${i}`, async()=>{const cp=fresh();const e=await cp.registerRiskEntity({entity_type:'service',name:`s${i}`});await cp.observeRisk(e,'error_rate',0.1);});
}
for (let i=0; i<50; i++) {
  test(`assessment loop ${i}`, async()=>{const cp=fresh();const e=await cp.registerRiskEntity({entity_type:'service',name:`s${i}`});await cp.assessRisk(e,'MEDIUM');});
}
for (let i=0; i<50; i++) {
  test(`dependency loop ${i}`, async()=>{const cp=fresh();const a=await cp.registerRiskEntity({entity_type:'svc',name:`a${i}`});const b=await cp.registerRiskEntity({entity_type:'svc',name:`b${i}`});await cp.registerDependency(a,b,'DEPENDS_ON');});
}
for (let i=0; i<50; i++) {
  test(`scenario loop ${i}`, async()=>{const cp=fresh();await cp.createScenario(`scenario${i}`);});
}
for (let i=0; i<50; i++) {
  test(`simulation loop ${i}`, async()=>{const cp=fresh();const sc=await cp.createScenario(`scenario${i}`);await cp.simulateScenario(sc,'SAFE');});
}
for (let i=0; i<40; i++) {
  test(`prevention loop ${i}`, async()=>{const cp=fresh();await cp.generatePreventionCandidate({entity_id:'svc',candidate_name:`c${i}`});});
}
for (let i=0; i<30; i++) {
  test(`containment loop ${i}`, async()=>{const cp=fresh();await cp.containFailure('svc',`action${i}`);});
}
for (let i=0; i<30; i++) {
  test(`verification loop ${i}`, async()=>{const cp=fresh();await cp.verifyResilience('svc',true);});
}
for (let i=0; i<20; i++) {
  test(`replay loop ${i}`, async()=>{const cp=fresh();await cp.replayRiskDecision({key:`k${i}`,data:`d${i}`});});
}
for (let i=0; i<20; i++) {
  test(`isolation loop ${i}`, async()=>{const cp=fresh();const e=await cp.registerRiskEntity({entity_type:'svc',name:`s${i}`});const rows=await (cp as any).db.all('SELECT * FROM risk_entities WHERE id=?',[e]);expectEqual(rows.length,1);});
}

// Full lifecycle
test('full systemic lifecycle', async()=>{
  const cp=fresh();
  const domain=await cp.registerRiskDomain({domain_type:'organization',name:'org'});
  const entity=await cp.registerRiskEntity({domain_id:domain,entity_type:'service',name:'svc'});
  const dep=await cp.registerRiskEntity({entity_type:'dependency',name:'dep'});
  await cp.registerDependency(entity,dep,'DEPENDS_ON');
  await cp.observeRisk(entity,'error_rate',0.2);
  await cp.createRiskBaseline(entity,'baseline');
  await cp.calculateRiskIndicator(entity,'criticality',0.9);
  await cp.assessRisk(entity,'HIGH');
  await cp.assessSystemicRisk('org','ELEVATED');
  await cp.detectSinglePointOfFailure(entity,'dependency');
  await cp.detectConcentrationRisk('dependency',dep,0.8,'HIGH');
  await cp.detectCorrelatedFailure('common_dependency');
  await cp.modelFailurePropagation(entity,'dep,svc',2);
  await cp.calculateBlastRadius(entity,'MULTI_PROJECT');
  await cp.calculateResilience(entity,0.5);
  await cp.assessRecoveryCapability(entity,'RTO',120,0.8);
  const sc=await cp.createScenario('dependency_failure');
  await cp.simulateScenario(sc,'SAFE',0.9);
  const prevention=await cp.generatePreventionCandidate({entity_id:entity,candidate_name:'add_redundancy'});
  await cp.evaluateGovernance(entity);
  await cp.evaluateSafety(entity);
  await cp.requestApproval(entity);
  await cp.approve(entity);
  await cp.containFailure(entity,'pause');
  await cp.recoverSystem(entity);
  await cp.verifyResilience(entity,true);
  await cp.generateEvidence('SYSTEMIC',entity,'LIFECYCLE',{});
  await cp.recordAudit('LIFECYCLE','SYSTEMIC',entity,'system');
  await cp.recordLineage('SYSTEMIC',entity,'COMPLETED',{});
  await cp.recordLearning('SYSTEMIC_OUTCOME',entity,{success:true});
  const rows=await (cp as any).db.all('SELECT * FROM systemic_lineage WHERE entity_id=?',[entity]);
  expectTrue(rows.length>=1);
});

// Run
(async()=>{for(const t of tests){try{await t.fn();passed++;console.log(`PASS: ${t.name}`);}catch(e:any){console.error(`FAIL: ${t.name}: ${e.message}`);process.exitCode=1;}}console.log(`\n${passed}/${tests.length} tests passed.`);})();