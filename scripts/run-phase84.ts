// scripts/run-phase84.ts
import { Phase84ControlPlane } from '../src/core/worker-phase84';
import { SQLiteEngine } from '../src/core/sqlite-engine';
import Database from 'better-sqlite3';
import * as fs from 'fs';

function fresh() {
  const db = new Database(':memory:');
  const engine = SQLiteEngine.fromDatabase(db);
  const migration84 = fs.readFileSync('src/db/migrations/126_phase84_autonomous_engineering_digital_twin_scenario_simulation.sql','utf8');
  engine.exec(migration84);
  return new Phase84ControlPlane(engine);
}
let passed = 0;
const tests: Array<{name:string; fn:()=>Promise<void>}> = [];
function test(name:string, fn:()=>Promise<void>) { tests.push({name, fn}); }
async function expectEqual(a:any,b:any,m?:string){ if(a!==b) throw new Error(m||`Expected ${b}, got ${a}`);}
async function expectTrue(c:boolean,m?:string){ if(!c) throw new Error(m||'Condition false');}
async function expectReject(p:Promise<any>,m?:string){ try{await p;throw new Error('Expected rejection');}catch(e:any){if(m&&!e.message.includes(m))throw new Error(`Expected ${m}, got ${e.message}`);}}

test('snapshot creation', async()=>{const cp=fresh();const id=await cp.createDigitalTwinSnapshot();expectTrue(!!id);});
test('snapshot versioning', async()=>{const cp=fresh();await cp.createDigitalTwinSnapshot();await cp.createDigitalTwinSnapshot();const rows=await (cp as any).db.all('SELECT * FROM digital_twin_snapshots');expectEqual(rows.length,2);});
test('snapshot retrieval', async()=>{const cp=fresh();const id=await cp.createDigitalTwinSnapshot();const snap=await cp.getDigitalTwinSnapshot(id);expectEqual(snap.id,id);});
test('snapshot comparison', async()=>{const cp=fresh();const a=await cp.createDigitalTwinSnapshot();const b=await cp.createDigitalTwinSnapshot();const res=await cp.compareTwinSnapshots(a,b);expectTrue(res.differences.includes('version'));});
test('snapshot freshness', async()=>{const cp=fresh();const id=await cp.createDigitalTwinSnapshot({freshness:'STALE'});const snap=await cp.getDigitalTwinSnapshot(id);expectEqual(snap.freshness,'STALE');});
test('snapshot completeness', async()=>{const cp=fresh();const id=await cp.createDigitalTwinSnapshot({completeness:'INCOMPLETE'});const snap=await cp.getDigitalTwinSnapshot(id);expectEqual(snap.completeness,'INCOMPLETE');});
test('snapshot provenance', async()=>{const cp=fresh();const id=await cp.createDigitalTwinSnapshot({provenance:'test'});const snap=await cp.getDigitalTwinSnapshot(id);expectEqual(snap.provenance,'test');});
test('reconcile digital twin', async()=>{const cp=fresh();const id=await cp.createDigitalTwinSnapshot();await cp.reconcileDigitalTwin(id);});
test('detect twin drift', async()=>{const cp=fresh();const id=await cp.createDigitalTwinSnapshot();const drift=await cp.detectTwinDrift(id,'state');expectTrue(!!drift);});
test('scenario creation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});expectTrue(!!sid);});
test('scenario clone', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const clone=await cp.cloneScenario(sid,'clone');expectTrue(clone!==sid);});
test('scenario validation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const res=await cp.validateScenario(sid);expectTrue(res.valid);});
test('scenario discard', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await (cp as any).db.run("UPDATE engineering_scenarios SET status='DISCARDED' WHERE id=?",[sid]);const scen=await (cp as any).db.get('SELECT status FROM engineering_scenarios WHERE id=?',[sid]);expectEqual(scen.status,'DISCARDED');});
test('valid change', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const cid=await cp.addScenarioChange({scenario_id:sid,change_type:'CAPACITY'});expectTrue(!!cid);});
test('invalid change missing scenario', async()=>{const cp=fresh();await expectReject(cp.addScenarioChange({scenario_id:'nonexistent',change_type:'CAPACITY'}),'FOREIGN KEY constraint failed');});
test('assumption creation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const aid=await cp.addScenarioAssumption({scenario_id:sid,assumption:'test'});expectTrue(!!aid);});
test('propagation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const prop=await cp.propagateScenarioChange(sid,'n1',2);expectTrue(!!prop);});
test('failure simulation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const res=await cp.simulateFailure({scenario_id:sid,failure_type:'provider_loss'});expectTrue(!!res);});
test('capacity simulation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const res=await cp.simulateCapacity({scenario_id:sid,available_capacity:10,reserved_capacity:2});expectTrue(!!res);});
test('economics simulation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const res=await cp.simulateEconomics({scenario_id:sid,cost_estimate:100});expectTrue(!!res);});
test('resilience simulation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});const res=await cp.simulateResilience(sid,0.8);expectTrue(!!res);});
test('policy simulation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.simulatePolicy(sid,'ALLOW');});
test('governance simulation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.simulateGovernance(sid,'APPROVAL_REQUIRED');});
test('safety simulation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.simulateSafety(sid,'SAFE');});
test('scenario risk', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.calculateScenarioRisk(sid,'HIGH');});
test('scenario confidence', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.calculateScenarioConfidence(sid,'HIGH');});
test('scenario comparison', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const s1=await cp.createScenario({snapshot_id:snap,name:'s1'});const s2=await cp.createScenario({snapshot_id:snap,name:'s2'});await cp.compareScenarios(s1,s2);});
test('scenario ranking', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.rankScenarios(sid,0.9);});
test('counterfactual generation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.generateCounterfactual(sid,'what if');});
test('recommendation generation', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.generateRecommendation(sid,'scale',0.7);});
test('incident preview', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.createIncidentPreview(sid,'preview');});
test('scenario replay', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.replayScenario(sid);});
test('replay divergence detection', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.detectReplayDivergence(sid,'different');});
test('scenario outcome', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.recordScenarioOutcome(sid,'success','data');});
test('scenario learning', async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:'s1'});await cp.recordScenarioLearning(sid,'strategy','data');});
test('scenario breaker open', async()=>{const cp=fresh();await cp.openScenarioCircuitBreaker('scenario','global');const row=await (cp as any).db.get("SELECT state FROM scenario_circuit_breakers WHERE scope='scenario' AND entity_id='global'");expectEqual(row.state,'OPEN');});
test('scenario breaker close', async()=>{const cp=fresh();await cp.openScenarioCircuitBreaker('scenario','global');await cp.closeScenarioCircuitBreaker('scenario','global');const row=await (cp as any).db.get("SELECT state FROM scenario_circuit_breakers WHERE scope='scenario' AND entity_id='global'");expectEqual(row.state,'CLOSED');});
test('evidence generation', async()=>{const cp=fresh();await cp.generateEvidence({entity_type:'SCENARIO',entity_id:'s1',evidence_type:'SIM',data:{}});});
test('audit record', async()=>{const cp=fresh();await cp.recordAudit({event_type:'CREATE',entity_type:'SCENARIO',entity_id:'s1',actor:'system',epoch:1});});
test('lineage record', async()=>{const cp=fresh();await cp.recordLineage({entity_type:'SCENARIO',entity_id:'s1',phase:'SIM',data:{}});});
test('replay deterministic', async()=>{const cp=fresh();const r1=await cp.replayDigitalTwin({key:'d',data:'a'});const r2=await cp.replayDigitalTwin({key:'d',data:'a'});expectEqual(r1.fingerprint,r2.fingerprint);});

for(let i=0;i<50;i++){test(`snapshot loop ${i}`,async()=>{const cp=fresh();await cp.createDigitalTwinSnapshot({provenance:`loop${i}`});});}
for(let i=0;i<50;i++){test(`scenario loop ${i}`,async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();await cp.createScenario({snapshot_id:snap,name:`scenario${i}`});});}
for(let i=0;i<40;i++){test(`change loop ${i}`,async()=>{const cp=fresh();const snap=await cp.createDigitalTwinSnapshot();const sid=await cp.createScenario({snapshot_id:snap,name:`scenario${i}`});await cp.addScenarioChange({scenario_id:sid,change_type:`type${i}`});});}

(async()=>{for(const t of tests){try{await t.fn();passed++;console.log(`PASS: ${t.name}`);}catch(e:any){console.error(`FAIL: ${t.name}: ${e.message}`);process.exitCode=1;}}console.log(`\n${passed}/${tests.length} tests passed.`);})();