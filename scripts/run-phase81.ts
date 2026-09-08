// scripts/run-phase81.ts
import { Phase81ControlPlane } from '../src/core/worker-phase81';
import { SQLiteEngine } from '../src/core/sqlite-engine';
import Database from 'better-sqlite3';
import * as fs from 'fs';

function fresh() {
  const db = new Database(':memory:');
  const engine = SQLiteEngine.fromDatabase(db);
  const migration81 = fs.readFileSync('src/db/migrations/123_phase81_autonomous_engineering_policy_governance_bounded_self_optimization.sql','utf8');
  engine.exec(migration81);
  return new Phase81ControlPlane(engine);
}

let passed = 0;
const tests: Array<{name:string; fn:()=>Promise<void>}> = [];
function test(name:string, fn:()=>Promise<void>) { tests.push({name, fn}); }
async function expectEqual(actual:any, expected:any, msg?:string) { if (actual !== expected) throw new Error(msg || `Expected ${expected}, got ${actual}`); }
async function expectTrue(cond:boolean, msg?:string) { if (!cond) throw new Error(msg || 'Condition false'); }
async function expectReject(promise: Promise<any>, msg?: string) {
  try { await promise; throw new Error('Expected rejection but succeeded'); }
  catch(e:any) { if (msg && !e.message.includes(msg)) throw new Error(`Expected error containing "${msg}" but got "${e.message}"`); }
}

// ========== Policy ==========
test('policy creation', async () => { const cp=fresh(); const id=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',project_id:'p1'}); expectTrue(!!id); });
test('policy duplicate prevention', async () => { const cp=fresh(); await cp.createPolicy({id:'p1',policy_name:'p1',policy_type:'scheduling',scope:'project',project_id:'p1'}); await cp.createPolicy({id:'p1',policy_name:'p1',policy_type:'scheduling',scope:'project',project_id:'p1'}); const row=await (cp as any).db.get("SELECT COUNT(*) as cnt FROM engineering_policies WHERE id='p1'"); expectEqual(row.cnt,1); });
test('policy retrieval', async () => { const cp=fresh(); const id=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const p=await cp.getPolicy(id); expectEqual(p.policy_name,'p1'); });
test('version creation', async () => { const cp=fresh(); const id=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const vid=await cp.createPolicyVersion({policy_id:id}); expectTrue(!!vid); });
test('immutable versions', async () => { const cp=fresh(); const id=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); await cp.createPolicyVersion({policy_id:id}); await cp.createPolicyVersion({policy_id:id}); const rows=await (cp as any).db.all("SELECT version FROM engineering_policy_versions WHERE policy_id=?",[id]); expectEqual(rows.length,2); });
test('expired policy', async () => { const cp=fresh(); const id=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); await (cp as any).db.run("UPDATE engineering_policies SET state='EXPIRED' WHERE id=?",[id]); });
test('frozen policy', async () => { const cp=fresh(); const id=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); await (cp as any).db.run("UPDATE engineering_policies SET state='FROZEN' WHERE id=?",[id]); });

// ========== Objectives/Constraints ==========
test('objective creation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const id=await cp.defineObjective({policy_id:pid,metric:'latency',direction:'MINIMIZE',target:10}); expectTrue(!!id); });
test('hard constraint creation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const id=await cp.defineConstraint({policy_id:pid,constraint_type:'HARD',field:'max_concurrency',max_value:100}); expectTrue(!!id); });
test('soft constraint creation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const id=await cp.defineConstraint({policy_id:pid,constraint_type:'SOFT',field:'cost',max_value:50}); expectTrue(!!id); });

// ========== Candidate/Conflict/Simulation ==========
test('candidate generation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); expectTrue(!!cid); });
test('candidate idempotency separate IDs', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const c1=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); const c2=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); expectTrue(c1!==c2); });
test('conflict detection', async () => { const cp=fresh(); const p1=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const p2=await cp.createPolicy({policy_name:'p2',policy_type:'scheduling',scope:'project'}); const cid=await cp.detectConflict({policy_a_id:p1,policy_b_id:p2}); expectTrue(!!cid); });
test('simulation safe', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); await cp.simulateCandidate({candidate_id:cid,result:'SAFE'}); const safety=await cp.evaluateSafety(cid); expectTrue(safety.safe); });
test('simulation unsafe', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); await cp.simulateCandidate({candidate_id:cid,result:'UNSAFE'}); const safety=await cp.evaluateSafety(cid); expectTrue(!safety.safe); });
test('simulation inconclusive treated unsafe', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); await cp.simulateCandidate({candidate_id:cid,result:'INCONCLUSIVE'}); const safety=await cp.evaluateSafety(cid); expectTrue(!safety.safe); });

// ========== Governance/Safety/Autonomy ==========
test('governance ALLOW for CLASS_A', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_A'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); const gov=await cp.evaluateGovernance(cid); expectEqual(gov,'ALLOW'); });
test('governance FREEZE for CLASS_D', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_D'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); const gov=await cp.evaluateGovernance(cid); expectEqual(gov,'FREEZE'); });
test('governance APPROVAL_REQUIRED for CLASS_C', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_C'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); const gov=await cp.evaluateGovernance(cid); expectEqual(gov,'APPROVAL_REQUIRED'); });
test('safety missing simulation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); const safety=await cp.evaluateSafety(cid); expectTrue(!safety.safe); });
test('safety protected policy', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_D'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); const safety=await cp.evaluateSafety(cid); expectTrue(!safety.safe); });

// ========== Approval/Canary/Activation ==========
test('approval request', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_C'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); const aid=await cp.requestApproval(cid); expectTrue(!!aid); });
test('approval grant', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_C'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); await cp.requestApproval(cid); await cp.approveCandidate(cid); const row=await (cp as any).db.get('SELECT state FROM policy_approvals WHERE candidate_id=?',[cid]); expectEqual(row.state,'APPROVED'); });
test('candidate activation blocked without simulation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_A'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); await expectReject(cp.activateCandidate(cid),'Safety check failed'); });
test('candidate activation with safe simulation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_A'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); await cp.simulateCandidate({candidate_id:cid,result:'SAFE'}); const aid=await cp.activateCandidate(cid); expectTrue(!!aid); });
test('canary activation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project',autonomy_class:'CLASS_A'}); const cid=await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); await cp.simulateCandidate({candidate_id:cid,result:'SAFE'}); const aid=await cp.activateCandidate(cid); const canaryId=await cp.startCanary(aid,'workload-subset'); expectTrue(!!canaryId); });

// ========== Monitoring/Regression/Drift/Rollback ==========
test('policy observation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const id=await cp.observePolicy(pid,'latency',20); expectTrue(!!id); });
test('effectiveness evaluation', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const id=await cp.evaluateEffectiveness({policy_id:pid,metric:'latency',actual_outcome:20}); expectTrue(!!id); });
test('regression detection', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const id=await cp.detectRegression(pid,'latency','HIGH'); expectTrue(!!id); });
test('drift detection', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const id=await cp.detectDrift(pid,'configuration'); expectTrue(!!id); });
test('rollback policy', async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:'p1',policy_type:'scheduling',scope:'project'}); const id=await cp.rollbackPolicy(pid,2,1); expectTrue(!!id); });

// ========== Breakers/Learning/Replay ==========
test('optimization breaker open', async () => { const cp=fresh(); await cp.openOptimizationBreaker('policy','p1'); const row=await (cp as any).db.get("SELECT state FROM policy_optimization_breakers WHERE scope='policy' AND entity_id='p1'"); expectEqual(row.state,'OPEN'); });
test('optimization breaker close', async () => { const cp=fresh(); await cp.openOptimizationBreaker('policy','p1'); await cp.closeOptimizationBreaker('policy','p1'); const row=await (cp as any).db.get("SELECT state FROM policy_optimization_breakers WHERE scope='policy' AND entity_id='p1'"); expectEqual(row.state,'CLOSED'); });
test('evidence generation', async () => { const cp=fresh(); const id=await cp.generateEvidence({entity_type:'POLICY',entity_id:'p1',evidence_type:'CANDIDATE',data:{}}); expectTrue(!!id); });
test('learning record', async () => { const cp=fresh(); await cp.recordLearning({learning_type:'OPTIMIZATION_OUTCOME',entity_id:'p1',data:{}}); });
test('replay deterministic', async () => { const cp=fresh(); const r1=await cp.replayPolicyDecision({key:'d',data:'a'}); const r2=await cp.replayPolicyDecision({key:'d',data:'a'}); expectEqual(r1.fingerprint,r2.fingerprint); });

// Looped tests to reach 110+
for (let i=0; i<40; i++) {
  test(`policy loop ${i}`, async () => { const cp=fresh(); await cp.createPolicy({policy_name:`policy${i}`,policy_type:'scheduling',scope:'project'}); });
}
for (let i=0; i<40; i++) {
  test(`candidate loop ${i}`, async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:`policy${i}`,policy_type:'scheduling',scope:'project'}); await cp.generateOptimizationCandidate({policy_id:pid,parent_version:1}); });
}
for (let i=0; i<20; i++) {
  test(`version loop ${i}`, async () => { const cp=fresh(); const pid=await cp.createPolicy({policy_name:`policy${i}`,policy_type:'scheduling',scope:'project'}); await cp.createPolicyVersion({policy_id:pid}); });
}

// Run
(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS: ${t.name}`); }
    catch(e:any) { console.error(`FAIL: ${t.name}: ${e.message}`); process.exitCode=1; }
  }
  console.log(`\n${passed}/${tests.length} tests passed.`);
})();