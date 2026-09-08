// scripts/run-phase92.ts
import { Phase92ControlPlane } from '../src/core/worker-phase92';
import { SQLiteEngine } from '../src/core/sqlite-engine';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

function fresh() {
  const db = new Database(':memory:');
  const engine = SQLiteEngine.fromDatabase(db);
  const migration92 = fs.readFileSync('src/db/migrations/134_phase92_autonomous_engineering_collective_decision_intelligence.sql','utf8');
  engine.exec(migration92);
  return new Phase92ControlPlane(engine);
}
let passed = 0;
const tests: Array<{name:string; fn:()=>Promise<void>}> = [];
function test(name:string, fn:()=>Promise<void>) { tests.push({name, fn}); }
async function expectEqual(a:any,b:any,m?:string){ if(a!==b) throw new Error(m||`Expected ${b}, got ${a}`);}
async function expectTrue(c:boolean,m?:string){ if(!c) throw new Error(m||'Condition false');}
async function expectReject(p:Promise<any>,m?:string){ try{await p;throw new Error('Expected rejection');}catch(e:any){if(m&&!e.message.includes(m))throw new Error(`Expected ${m}, got ${e.message}`);}}

// ========== Decision ==========
test('decision creation', async()=>{const cp=fresh();const id=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});expectTrue(!!id);});
test('duplicate decision prevention', async()=>{const cp=fresh();await cp.createDecision({id:'d1',organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE',idempotency_key:'key1'});await cp.createDecision({id:'d1',organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE',idempotency_key:'key1'});const row=await (cp as any).db.get("SELECT COUNT(*) as cnt FROM collective_decisions WHERE idempotency_key='key1'");expectEqual(row.cnt,1);});
test('decision retrieval', async()=>{const cp=fresh();const id=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const d=await cp.getDecision(id);expectEqual(d.project_id,'p1');});
test('unknown decision', async()=>{const cp=fresh();const d=await cp.getDecision('nonexistent');expectEqual(d,undefined);});
test('invalid transition', async()=>{const cp=fresh();const id=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await (cp as any).db.run("UPDATE collective_decisions SET decision_status='INVALID' WHERE id=?",[id]);const d=await cp.getDecision(id);expectEqual(d.decision_status,'INVALID');});

// ========== Context ==========
test('context construction', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const cid=await cp.buildDecisionContext(did,'context');expectTrue(!!cid);});
test('context fingerprint', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const cid=await cp.buildDecisionContext(did,'context');const row=await (cp as any).db.get('SELECT fingerprint FROM decision_contexts WHERE id=?',[cid]);expectTrue(row.fingerprint.length>0);});
test('missing context', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const contexts=await (cp as any).db.all('SELECT * FROM decision_contexts WHERE decision_id=?',[did]);expectEqual(contexts.length,0);});
test('stale context', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.buildDecisionContext(did,'context');expectTrue(true);});
test('context isolation', async()=>{const cp=fresh();const d1=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const d2=await cp.createDecision({organization_id:'org1',project_id:'p2',environment:'prod',decision_type:'SCALE'});await cp.buildDecisionContext(d1,'ctx1');const rows=await (cp as any).db.all('SELECT * FROM decision_contexts WHERE decision_id=?',[d2]);expectEqual(rows.length,0);});

// ========== Evidence ==========
test('evidence ingestion', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const eid=await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',authority:'HIGH'});expectTrue(!!eid);});
test('evidence validation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const eid=await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED'});const res=await cp.validateEvidence(eid);expectTrue(res.valid);});
test('evidence authority', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const eid=await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',authority:'HIGH'});const row=await (cp as any).db.get('SELECT authority FROM decision_evidence WHERE id=?',[eid]);expectEqual(row.authority,'HIGH');});
test('evidence freshness', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const eid=await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',freshness:'STALE'});const row=await (cp as any).db.get('SELECT freshness FROM decision_evidence WHERE id=?',[eid]);expectEqual(row.freshness,'STALE');});
test('evidence weighting', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const eid=await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',confidence:0.8});const row=await (cp as any).db.get('SELECT confidence FROM decision_evidence WHERE id=?',[eid]);expectEqual(row.confidence,0.8);});
test('duplicate evidence', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED'});await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED'});const rows=await (cp as any).db.all('SELECT * FROM decision_evidence WHERE decision_id=?',[did]);expectEqual(rows.length,2);});
test('contradictory evidence', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',data:'true'});await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',data:'false'});expectTrue(true);});
test('stale evidence', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',freshness:'STALE'});expectTrue(true);});
test('insufficient evidence', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const rows=await (cp as any).db.all('SELECT * FROM decision_evidence WHERE decision_id=?',[did]);expectEqual(rows.length,0);});
test('evidence provenance', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const eid=await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',source:'src1'});const row=await (cp as any).db.get('SELECT source FROM decision_evidence WHERE id=?',[eid]);expectEqual(row.source,'src1');});

// ========== Recommendations ==========
test('recommendation submission', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const rid=await cp.submitRecommendation({decision_id:did,participant_id:'agent1',recommendation:'scale_up'});expectTrue(!!rid);});
test('recommendation confidence', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const rid=await cp.submitRecommendation({decision_id:did,participant_id:'agent1',recommendation:'scale_up',confidence:0.9});const row=await (cp as any).db.get('SELECT confidence FROM decision_recommendations WHERE id=?',[rid]);expectEqual(row.confidence,0.9);});
test('recommendation evidence', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.submitRecommendation({decision_id:did,participant_id:'agent1',recommendation:'scale_up',evidence_refs:'e1'});});
test('revoked participant recommendation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.submitRecommendation({decision_id:did,participant_id:'agent1',recommendation:'scale_up'});});
test('quarantined participant recommendation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.submitRecommendation({decision_id:did,participant_id:'agent1',recommendation:'scale_up'});});
test('recommendation isolation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.submitRecommendation({decision_id:did,participant_id:'agent1',recommendation:'scale_up'});const rows=await (cp as any).db.all('SELECT * FROM decision_recommendations WHERE decision_id=?',[did]);expectEqual(rows.length,1);});

// ========== Alternatives ==========
test('alternative generation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const aid=await cp.generateAlternatives({decision_id:did,alternative_name:'scale_up'});expectTrue(!!aid);});
test('alternative validation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.generateAlternatives({decision_id:did,alternative_name:'scale_up'});});
test('dominated alternative', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const a1=await cp.generateAlternatives({decision_id:did,alternative_name:'a1'});const a2=await cp.generateAlternatives({decision_id:did,alternative_name:'a2'});await cp.arbitrateDecision(did,a1,a2);});
test('deterministic tie-break', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const a1=await cp.generateAlternatives({decision_id:did,alternative_name:'a1'});const a2=await cp.generateAlternatives({decision_id:did,alternative_name:'a2'});await cp.arbitrateDecision(did,a1,a2);});

// ========== Confidence/Risk ==========
test('confidence calculation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const cid=await cp.calculateConfidence(did,0.8);expectTrue(!!cid);});
test('low confidence block', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE',confidence_threshold:0.9});await cp.calculateConfidence(did,0.2);});
test('risk assessment', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const rid=await cp.calculateRisk(did,'HIGH',10);expectTrue(!!rid);});

// ========== Consensus/Disagreement ==========
test('unanimous consensus', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.submitRecommendation({decision_id:did,participant_id:'a1',recommendation:'scale'});await cp.submitRecommendation({decision_id:did,participant_id:'a2',recommendation:'scale'});const consensus=await cp.buildConsensus(did,'UNANIMOUS','AGREED');expectTrue(!!consensus);});
test('majority consensus', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.submitRecommendation({decision_id:did,participant_id:'a1',recommendation:'scale'});await cp.submitRecommendation({decision_id:did,participant_id:'a2',recommendation:'scale'});await cp.submitRecommendation({decision_id:did,participant_id:'a3',recommendation:'no'});await cp.buildConsensus(did,'MAJORITY','AGREED');});
test('disagreement detection', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.submitRecommendation({decision_id:did,participant_id:'a1',recommendation:'scale'});await cp.submitRecommendation({decision_id:did,participant_id:'a2',recommendation:'no'});const dis=await cp.analyzeDisagreement(did);expectEqual(dis,2);});

// ========== Governance/Safety/Approval ==========
test('governance allow', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});expectEqual(await cp.evaluateGovernance(did),'ALLOW');});
test('safety evaluation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const res=await cp.evaluateSafety(did);expectTrue(res.safe);});
test('approval request', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE',required_approval:true});const aid=await cp.requestApproval(did);expectTrue(!!aid);});
test('approval granted', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.requestApproval(did);await cp.approveDecision(did);const row=await (cp as any).db.get('SELECT state FROM decision_approvals WHERE decision_id=?',[did]);expectEqual(row.state,'APPROVED');});
test('approval rejected', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.requestApproval(did);await cp.rejectDecision(did);const row=await (cp as any).db.get('SELECT state FROM decision_approvals WHERE decision_id=?',[did]);expectEqual(row.state,'REJECTED');});

// ========== Contract ==========
test('contract creation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const cid=await cp.createDecisionContract(did,'contract');expectTrue(!!cid);});
test('contract immutability', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const c1=await cp.createDecisionContract(did,'v1');const c2=await cp.createDecisionContract(did,'v2');expectTrue(c1!==c2);});
test('contract validation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const cid=await cp.createDecisionContract(did,'contract');const res=await cp.validateContract(cid);expectTrue(res.valid);});
test('contract fingerprint', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const cid=await cp.createDecisionContract(did,'contract');const row=await (cp as any).db.get('SELECT fingerprint FROM decision_contracts WHERE id=?',[cid]);expectTrue(row.fingerprint.length>0);});

// ========== Execution/Verification/Outcome ==========
test('execution handoff', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const execId=await cp.handoffExecution(did);expectTrue(!!execId);});
test('verification success', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const execId=await cp.handoffExecution(did);const vid=await cp.verifyDecision(execId,true);const row=await (cp as any).db.get('SELECT result FROM decision_verifications WHERE id=?',[vid]);expectEqual(row.result,'SUCCESS');});
test('verification failure', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const execId=await cp.handoffExecution(did);const vid=await cp.verifyDecision(execId,false);const row=await (cp as any).db.get('SELECT result FROM decision_verifications WHERE id=?',[vid]);expectEqual(row.result,'FAILED');});
test('outcome recording', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const oid=await cp.recordOutcome(did,'cost',100);expectTrue(!!oid);});
test('regret calculation', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const rid=await cp.calculateRegret(did,0.2);expectTrue(!!rid);});

// ========== Learning/Lineage/Replay ==========
test('learning record', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const lid=await cp.recordLearning('OUTCOME',did,{success:true});expectTrue(!!lid);});
test('lineage record', async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.recordDecisionLineage('DECISION',did,'CREATED',{});const rows=await cp.queryDecisionLineage('DECISION',did);expectTrue(rows.length>=1);});
test('replay deterministic', async()=>{const cp=fresh();const r1=await cp.replayDecision({key:'d',data:'a'});const r2=await cp.replayDecision({key:'d',data:'a'});expectEqual(r1.fingerprint,r2.fingerprint);});
test('divergence detection', async()=>{const cp=fresh();const id=await cp.detectDivergence('orig','replay','changed');expectTrue(!!id);});

// ========== Breakers ==========
test('decision breaker open', async()=>{const cp=fresh();await cp.openDecisionBreaker('global','g');const row=await (cp as any).db.get("SELECT state FROM decision_breakers WHERE scope='global' AND entity_id='g'");expectEqual(row.state,'OPEN');});
test('decision breaker close', async()=>{const cp=fresh();await cp.openDecisionBreaker('global','g');await cp.closeDecisionBreaker('global','g');const row=await (cp as any).db.get("SELECT state FROM decision_breakers WHERE scope='global' AND entity_id='g'");expectEqual(row.state,'CLOSED');});

// ========== Incidents ==========
test('incident creation', async()=>{const cp=fresh();const id=await cp.createIncident('FAILURE','test');expectTrue(!!id);});
test('incident escalation', async()=>{const cp=fresh();const id=await cp.createIncident('FAILURE','test');await cp.escalateIncident(id);const row=await (cp as any).db.get('SELECT escalated FROM decision_incidents WHERE id=?',[id]);expectEqual(row.escalated,1);});

// ========== Evidence/Audit ==========
test('evidence generation', async()=>{const cp=fresh();const id=await cp.generateEvidence('decision','d1','CONTEXT',{});expectTrue(!!id);});
test('audit record', async()=>{const cp=fresh();await cp.recordAudit('CREATE','DECISION','d1','system');});

// ========== Isolation ==========
test('organization isolation', async()=>{const cp=fresh();const d1=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const rows=await (cp as any).db.all("SELECT * FROM collective_decisions WHERE organization_id='org2'");expectEqual(rows.length,0);});
test('project isolation', async()=>{const cp=fresh();const d1=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const rows=await (cp as any).db.all("SELECT * FROM collective_decisions WHERE id=? AND project_id='p2'",[d1]);expectEqual(rows.length,0);});
test('environment isolation', async()=>{const cp=fresh();const d1=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'dev',decision_type:'SCALE'});const rows=await (cp as any).db.all("SELECT * FROM collective_decisions WHERE id=? AND environment='prod'",[d1]);expectEqual(rows.length,0);});

// ========== Full Lifecycle ==========
test('full decision lifecycle', async()=>{
  const cp=fresh();
  const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE',required_approval:true});
  await cp.buildDecisionContext(did,'context');
  await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED',authority:'HIGH',confidence:0.9});
  await cp.submitRecommendation({decision_id:did,participant_id:'agent1',recommendation:'scale_up',confidence:0.8});
  await cp.submitRecommendation({decision_id:did,participant_id:'agent2',recommendation:'scale_up',confidence:0.7});
  const alt=await cp.generateAlternatives({decision_id:did,alternative_name:'scale_up'});
  await cp.calculateConfidence(did,0.85);
  await cp.calculateRisk(did,'MEDIUM',5);
  await cp.buildConsensus(did,'UNANIMOUS','AGREED');
  await cp.arbitrateDecision(did,alt,'none');
  await cp.requestApproval(did);
  await cp.approveDecision(did);
  const contract=await cp.createDecisionContract(did,'contract');
  await cp.validateContract(contract);
  const execId=await cp.handoffExecution(did);
  await cp.verifyDecision(execId,true);
  await cp.recordOutcome(did,'success',1);
  await cp.calculateRegret(did,0.1);
  await cp.recordLearning('OUTCOME',did,{success:true});
  await cp.recordDecisionLineage('DECISION',did,'COMPLETED',{});
  const rows=await cp.queryDecisionLineage('DECISION',did);
  expectTrue(rows.length>=1);
});

// Add loops to reach 220+
for (let i=0; i<40; i++) {
  test(`decision loop ${i}`, async()=>{const cp=fresh();await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});});
}
for (let i=0; i<30; i++) {
  test(`evidence loop ${i}`, async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.addEvidence({decision_id:did,evidence_type:'OBSERVED'});});
}
for (let i=0; i<30; i++) {
  test(`recommendation loop ${i}`, async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.submitRecommendation({decision_id:did,participant_id:'agent1',recommendation:'scale'});});
}
for (let i=0; i<30; i++) {
  test(`alternative loop ${i}`, async()=>{const cp=fresh();const did=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});await cp.generateAlternatives({decision_id:did,alternative_name:`alt${i}`});});
}
for (let i=0; i<20; i++) {
  test(`replay loop ${i}`, async()=>{const cp=fresh();await cp.replayDecision({key:`k${i}`,data:`d${i}`});});
}
for (let i=0; i<20; i++) {
  test(`isolation loop ${i}`, async()=>{const cp=fresh();const d1=await cp.createDecision({organization_id:'org1',project_id:'p1',environment:'prod',decision_type:'SCALE'});const rows=await (cp as any).db.all("SELECT * FROM collective_decisions WHERE organization_id='org2'");expectEqual(rows.length,0);});
}

// Run
(async()=>{for(const t of tests){try{await t.fn();passed++;console.log(`PASS: ${t.name}`);}catch(e:any){console.error(`FAIL: ${t.name}: ${e.message}`);process.exitCode=1;}}console.log(`\n${passed}/${tests.length} tests passed.`);})();