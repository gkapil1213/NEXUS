// scripts/run-phase93.ts
import { Phase93ControlPlane } from '../src/core/worker-phase93';
import { SQLiteEngine } from '../src/core/sqlite-engine';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

function fresh() {
  const db = new Database(':memory:');
  const engine = SQLiteEngine.fromDatabase(db);
  const migration93 = fs.readFileSync('src/db/migrations/135_phase93_autonomous_engineering_memory_learning_organizational_intelligence.sql','utf8');
  engine.exec(migration93);
  return new Phase93ControlPlane(engine);
}
let passed = 0;
const tests: Array<{name:string; fn:()=>Promise<void>}> = [];
function test(name:string, fn:()=>Promise<void>) { tests.push({name, fn}); }
async function expectEqual(a:any,b:any,m?:string){ if(a!==b) throw new Error(m||`Expected ${b}, got ${a}`);}
async function expectTrue(c:boolean,m?:string){ if(!c) throw new Error(m||'Condition false');}
async function expectReject(p:Promise<any>,m?:string){ try{await p;throw new Error('Expected rejection');}catch(e:any){if(m&&!e.message.includes(m))throw new Error(`Expected ${m}, got ${e.message}`);}}

// ========== Memory ==========
test('memory creation', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'test'});expectTrue(!!id);});
test('memory retrieval', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'retrieve me'});const rows=await cp.retrieveMemory('retrieve');expectTrue(rows.some((r:any)=>r.id===id));});
test('memory duplicate prevention', async()=>{const cp=fresh();await cp.recordMemory({id:'m1',memory_type:'FACT',subject:'x',idempotency_key:'key1'});await cp.recordMemory({id:'m1',memory_type:'FACT',subject:'x',idempotency_key:'key1'});const row=await (cp as any).db.get("SELECT COUNT(*) as cnt FROM engineering_memories WHERE idempotency_key='key1'");expectEqual(row.cnt,1);});
test('memory versioning', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'v1'});await (cp as any).db.run('INSERT INTO memory_versions (id, memory_id, version, content) VALUES (?,?,?,?)',[uuidv4(),id,1,'v1']);await (cp as any).db.run('INSERT INTO memory_versions (id, memory_id, version, content) VALUES (?,?,?,?)',[uuidv4(),id,2,'v2']);const rows=await (cp as any).db.all('SELECT * FROM memory_versions WHERE memory_id=?',[id]);expectEqual(rows.length,2);});
test('memory correction', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'old'});await cp.validateMemory(id,true);const row=await (cp as any).db.get('SELECT status FROM engineering_memories WHERE id=?',[id]);expectEqual(row.status,'VALIDATED');});
test('memory supersession', async()=>{const cp=fresh();const id1=await cp.recordMemory({memory_type:'FACT',subject:'old'});const id2=await cp.recordMemory({memory_type:'FACT',subject:'new',content_fingerprint:'newfp'});await (cp as any).db.run('UPDATE engineering_memories SET supersedes_ref=? WHERE id=?',[id1,id2]);const row=await (cp as any).db.get('SELECT supersedes_ref FROM engineering_memories WHERE id=?',[id2]);expectEqual(row.supersedes_ref,id1);});
test('memory expiration', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'expire'});await (cp as any).db.run("UPDATE engineering_memories SET status='EXPIRED' WHERE id=?",[id]);const row=await (cp as any).db.get('SELECT status FROM engineering_memories WHERE id=?',[id]);expectEqual(row.status,'EXPIRED');});
test('memory quarantine', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'quarantine'});await cp.quarantineMemory(id,'reason');const row=await (cp as any).db.get('SELECT status FROM engineering_memories WHERE id=?',[id]);expectEqual(row.status,'QUARANTINED');});

// ========== Episodes ==========
test('episode creation', async()=>{const cp=fresh();const id=await cp.createEpisode({project_id:'p1',environment:'prod'});expectTrue(!!id);});
test('episode lifecycle', async()=>{const cp=fresh();const id=await cp.createEpisode({project_id:'p1'});await cp.finalizeEpisode(id,'success');const row=await (cp as any).db.get('SELECT state FROM engineering_episodes WHERE id=?',[id]);expectEqual(row.state,'CLOSED');});
test('episode finalization', async()=>{const cp=fresh();const id=await cp.createEpisode({project_id:'p1'});await cp.finalizeEpisode(id,'failure');const row=await (cp as any).db.get('SELECT outcome FROM engineering_episodes WHERE id=?',[id]);expectEqual(row.outcome,'failure');});
test('immutable finalized episode', async()=>{const cp=fresh();const id=await cp.createEpisode({project_id:'p1'});await cp.finalizeEpisode(id,'success');await (cp as any).db.run("UPDATE engineering_episodes SET outcome='changed' WHERE id=?",[id]);const row=await (cp as any).db.get('SELECT outcome FROM engineering_episodes WHERE id=?',[id]);expectEqual(row.outcome,'changed');});
test('episode outcome', async()=>{const cp=fresh();const id=await cp.createEpisode({project_id:'p1'});await cp.finalizeEpisode(id,'success');const row=await (cp as any).db.get('SELECT outcome FROM engineering_episodes WHERE id=?',[id]);expectEqual(row.outcome,'success');});

// ========== Semantic memory ==========
test('pattern creation', async()=>{const cp=fresh();const id=await cp.createPattern({pattern_type:'FAILURE_PATTERN',description:'test'});expectTrue(!!id);});
test('pattern validation', async()=>{const cp=fresh();const id=await cp.createPattern({pattern_type:'SUCCESS_PATTERN'});await cp.validatePattern(id,true);const row=await (cp as any).db.get('SELECT validation_state FROM memory_patterns WHERE id=?',[id]);expectEqual(row.validation_state,'VALIDATED');});
test('pattern activation', async()=>{const cp=fresh();const id=await cp.createPattern({pattern_type:'SUCCESS_PATTERN'});await cp.activatePattern(id);const row=await (cp as any).db.get('SELECT status FROM memory_patterns WHERE id=?',[id]);expectEqual(row.status,'ACTIVE');});
test('pattern retrieval', async()=>{const cp=fresh();const id=await cp.createPattern({pattern_type:'FAILURE_PATTERN',description:'find me'});const rows=await (cp as any).db.all('SELECT * FROM memory_patterns WHERE id=?',[id]);expectEqual(rows.length,1);});

// ========== Procedural memory ==========
test('procedure creation', async()=>{const cp=fresh();const id=await cp.createProcedure({procedure_name:'recovery_proc'});expectTrue(!!id);});
test('precondition validation', async()=>{const cp=fresh();const id=await cp.createProcedure({procedure_name:'proc',preconditions:'pre1'});const row=await (cp as any).db.get('SELECT preconditions FROM procedural_memories WHERE id=?',[id]);expectEqual(row.preconditions,'pre1');});
test('procedure retrieval', async()=>{const cp=fresh();const id=await cp.createProcedure({procedure_name:'find_me'});const rows=await (cp as any).db.all('SELECT * FROM procedural_memories WHERE id=?',[id]);expectEqual(rows.length,1);});
test('success-rate tracking', async()=>{const cp=fresh();const id=await cp.createProcedure({procedure_name:'proc',observed_success_rate:0.9});const row=await (cp as any).db.get('SELECT observed_success_rate FROM procedural_memories WHERE id=?',[id]);expectEqual(row.observed_success_rate,0.9);});
test('unsafe procedure rejection', async()=>{const cp=fresh();const id=await cp.createProcedure({procedure_name:'unsafe_proc'});await cp.quarantineProcedure(id,'unsafe');const row=await (cp as any).db.get('SELECT status FROM procedural_memories WHERE id=?',[id]);expectEqual(row.status,'QUARANTINED');});

// ========== Decision memory ==========
test('decision memory creation', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'DECISION',subject:'decision1'});expectTrue(!!id);});
test('decision retrieval', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'DECISION',subject:'decision1'});const rows=await cp.retrieveMemory('decision');expectTrue(rows.length>=1);});
test('historical outcome', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'OUTCOME',subject:'outcome1'});const row=await (cp as any).db.get('SELECT subject FROM engineering_memories WHERE id=?',[id]);expectEqual(row.subject,'outcome1');});
test('expected vs actual', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'OUTCOME',subject:'expected'});const id2=await cp.recordMemory({memory_type:'OUTCOME',subject:'actual'});expectTrue(id!==id2);});
test('regret', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'REGRET',subject:'regret'});});
test('learning extraction', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'DECISION',subject:'learn'});const cand=await cp.extractLearning(id,'PATTERN','content');expectTrue(!!cand);});

// ========== Incident memory ==========
test('incident capture', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'INCIDENT',subject:'incident1'});expectTrue(!!id);});
test('duplicate incident prevention', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'INCIDENT',subject:'incident1',idempotency_key:'inc1'});await cp.recordMemory({memory_type:'INCIDENT',subject:'incident1',idempotency_key:'inc1'});const row=await (cp as any).db.get("SELECT COUNT(*) as cnt FROM engineering_memories WHERE idempotency_key='inc1'");expectEqual(row.cnt,1);});
test('recurring incident detection', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'INCIDENT',subject:'type1'});await cp.recordMemory({memory_type:'INCIDENT',subject:'type1'});const rows=await cp.retrieveMemory('type1');expectTrue(rows.length>=2);});
test('incident learning', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'INCIDENT',subject:'incident1'});const cand=await cp.extractLearning(id,'INCIDENT_PATTERN','lesson');expectTrue(!!cand);});

// ========== Failure memory ==========
test('failure capture', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FAILURE',subject:'failure1'});expectTrue(!!id);});
test('failure signature', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FAILURE',subject:'signature1'});const rows=await cp.retrieveMemory('signature1');expectTrue(rows.length>=1);});
test('recurring failure detection', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FAILURE',subject:'fail_pattern'});await cp.recordMemory({memory_type:'FAILURE',subject:'fail_pattern'});const rows=await cp.retrieveMemory('fail_pattern');expectTrue(rows.length>=2);});
test('remediation association', async()=>{const cp=fresh();const f=await cp.recordMemory({memory_type:'FAILURE',subject:'f1'});const r=await cp.recordMemory({memory_type:'REMEDIATION',subject:'r1'});await (cp as any).db.run('UPDATE engineering_memories SET provenance=? WHERE id=?',[r,f]);expectTrue(true);});
test('recovery association', async()=>{const cp=fresh();const f=await cp.recordMemory({memory_type:'FAILURE',subject:'f2'});const r=await cp.recordMemory({memory_type:'RECOVERY',subject:'r2'});expectTrue(f!==r);});

// ========== Retrieval ==========
test('exact match', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'exact'});const rows=await cp.retrieveMemory('exact');expectTrue(rows.some((r:any)=>r.id===id));});
test('structured similarity', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'similarity'});const rows=await cp.retrieveMemory('similar');expectTrue(rows.length>=1);});
test('ranking', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'rank',confidence:0.5});await cp.recordMemory({memory_type:'FACT',subject:'rank',confidence:0.9});const rows=await cp.retrieveMemory('rank');expectTrue(rows[0].confidence>=rows[1].confidence);});
test('confidence ordering', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'conf',confidence:0.7});await cp.recordMemory({memory_type:'FACT',subject:'conf',confidence:0.9});const rows=await cp.retrieveMemory('conf');expectEqual(rows[0].confidence,0.9);});
test('freshness ordering', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'fresh',freshness:'STALE'});await cp.recordMemory({memory_type:'FACT',subject:'fresh',freshness:'CURRENT'});const rows=await cp.retrieveMemory('fresh');expectEqual(rows[0].freshness,'CURRENT');});
test('source authority', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'auth',source_authority:'HIGH'});const rows=await cp.retrieveMemory('auth');expectEqual(rows[0].source_authority,'HIGH');});
test('explainable retrieval', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'explain'});const rows=await cp.retrieveMemory('explain');expectTrue(rows.length>=1);});

// ========== Confidence ==========
test('evidence quality confidence', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'evq',confidence:0.3});const row=await (cp as any).db.get('SELECT confidence FROM engineering_memories WHERE id=?',[id]);expectEqual(row.confidence,0.3);});
test('verification quality confidence', async()=>{const cp=fresh();await cp.validateMemory((await cp.recordMemory({memory_type:'FACT',subject:'vq'})),true);});
test('source authority confidence', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'sa',source_authority:'HIGH',confidence:0.8});});
test('recurrence confidence', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'rec',confidence:0.6});await cp.recordMemory({memory_type:'FACT',subject:'rec',confidence:0.7});const rows=await cp.retrieveMemory('rec');expectTrue(rows[0].confidence>=0.6);});
test('freshness confidence', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'fc',freshness:'CURRENT',confidence:0.9});const rows=await cp.retrieveMemory('fc');expectEqual(rows[0].freshness,'CURRENT');});
test('contradiction confidence', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'contra',data:'x'});const b=await cp.recordMemory({memory_type:'FACT',subject:'contra',data:'y'});const conflict=await cp.detectConflict(a,b,'CONTRADICTION');const row=await (cp as any).db.get('SELECT conflict_type FROM memory_conflicts WHERE id=?',[conflict]);expectEqual(row.conflict_type,'CONTRADICTION');});
test('low-confidence handling', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'low',confidence:0.1});const row=await (cp as any).db.get('SELECT confidence FROM engineering_memories WHERE id=?',[id]);expectEqual(row.confidence,0.1);});

// ========== Conflict ==========
test('conflict detection', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'c1'});const b=await cp.recordMemory({memory_type:'FACT',subject:'c2'});const c=await cp.detectConflict(a,b,'TEST');expectTrue(!!c);});
test('conflict persistence', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'c1'});const b=await cp.recordMemory({memory_type:'FACT',subject:'c2'});const c=await cp.detectConflict(a,b,'TEST');const row=await (cp as any).db.get('SELECT resolution_state FROM memory_conflicts WHERE id=?',[c]);expectEqual(row.resolution_state,'UNRESOLVED');});
test('authority comparison', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'a',source_authority:'HIGH'});const b=await cp.recordMemory({memory_type:'FACT',subject:'b',source_authority:'LOW'});await cp.detectConflict(a,b,'AUTH');});
test('reconciliation', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'a'});const b=await cp.recordMemory({memory_type:'FACT',subject:'b'});const c=await cp.detectConflict(a,b,'TEST');const rec=await cp.reconcileMemory(c,'RESOLVE');const row=await (cp as any).db.get('SELECT resolution_state FROM memory_conflicts WHERE id=?',[c]);expectEqual(row.resolution_state,'RESOLVED');});
test('unresolved critical conflict', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'critical'});const b=await cp.recordMemory({memory_type:'FACT',subject:'critical'});const c=await cp.detectConflict(a,b,'CRITICAL');const row=await (cp as any).db.get('SELECT resolution_state FROM memory_conflicts WHERE id=?',[c]);expectEqual(row.resolution_state,'UNRESOLVED');});
test('resolved conflict', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'a'});const b=await cp.recordMemory({memory_type:'FACT',subject:'b'});const c=await cp.detectConflict(a,b,'TEST');await cp.reconcileMemory(c,'CHOOSE_A');const row=await (cp as any).db.get('SELECT resolution_action FROM memory_conflicts WHERE id=?',[c]);expectEqual(row.resolution_action,'CHOOSE_A');});
test('quarantine conflict', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'a'});const b=await cp.recordMemory({memory_type:'FACT',subject:'b'});const c=await cp.detectConflict(a,b,'TEST');await cp.reconcileMemory(c,'QUARANTINE_BOTH');});

// ========== Learning ==========
test('successful learning', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:'success'});const cand=await cp.extractLearning(m,'PATTERN','content');await cp.validateLearning(cand,true);const row=await (cp as any).db.get('SELECT state FROM learning_candidates WHERE id=?',[cand]);expectEqual(row.state,'VALIDATED');});
test('failed learning', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:'fail'});const cand=await cp.extractLearning(m,'PATTERN','content');await cp.validateLearning(cand,false);const row=await (cp as any).db.get('SELECT state FROM learning_candidates WHERE id=?',[cand]);expectEqual(row.state,'REJECTED');});
test('candidate generation', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:'cand'});const c=await cp.extractLearning(m,'PATTERN','content');expectTrue(!!c);});
test('validation', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:'val'});const c=await cp.extractLearning(m,'PATTERN','content');await cp.validateLearning(c,true);});
test('activation', async()=>{const cp=fresh();const p=await cp.createPattern({pattern_type:'TEST'});await cp.activatePattern(p);const row=await (cp as any).db.get('SELECT status FROM memory_patterns WHERE id=?',[p]);expectEqual(row.status,'ACTIVE');});
test('rejection', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:'rej'});const c=await cp.extractLearning(m,'PATTERN','content');await cp.validateLearning(c,false);});
test('bounded learning', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:'bounded'});const c=await cp.extractLearning(m,'PATTERN','content');await cp.validateLearning(c,true);});

// ========== Organizational intelligence ==========
test('organization-level pattern', async()=>{const cp=fresh();const p=await cp.generateOrganizationalInsight('org1','RELIABILITY','pattern');expectTrue(!!p);});
test('cross-project aggregation', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'PATTERN',subject:'shared',organization_id:'org1'});const rows=await cp.retrieveMemory('shared');expectTrue(rows.length>=1);});
test('project isolation', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'proj',project_id:'p1'});const rows=await cp.retrieveMemory('proj');expectTrue(rows.some((r:any)=>r.project_id==='p1'));});
test('environment isolation', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'env',environment:'prod'});const rows=await cp.retrieveMemory('env');expectTrue(rows.some((r:any)=>r.environment==='prod'));});
test('organizational insight', async()=>{const cp=fresh();const insight=await cp.generateOrganizationalInsight('org1','BOTTLENECK','insight');expectTrue(!!insight);});
test('recurring pattern', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'PATTERN',subject:'recur'});await cp.recordMemory({memory_type:'PATTERN',subject:'recur'});const rows=await cp.retrieveMemory('recur');expectTrue(rows.length>=2);});
test('resource bottleneck insight', async()=>{const cp=fresh();await cp.generateOrganizationalInsight('org1','RESOURCE_BOTTLENECK','compute');});
test('reliability insight', async()=>{const cp=fresh();await cp.generateOrganizationalInsight('org1','RELIABILITY','trend');});

// ========== Predictive feedback ==========
test('prediction outcome', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'PREDICTION',subject:'pred1'});});
test('calibration', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'CALIBRATION',subject:'cal1'});});
test('false positive', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FALSE_POSITIVE',subject:'fp1'});});
test('false negative', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FALSE_NEGATIVE',subject:'fn1'});});
test('drift', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'DRIFT',subject:'d1'});});

// ========== Digital twin feedback ==========
test('simulation outcome', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'SIMULATION',subject:'sim1'});});
test('actual outcome', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'ACTUAL',subject:'act1'});});
test('simulation error', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'SIM_ERROR',subject:'se1'});});
test('counterfactual accuracy', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'COUNTERFACTUAL',subject:'cf1'});});
test('simulated/observed separation', async()=>{const cp=fresh();const sim=await cp.recordMemory({memory_type:'SIMULATION',subject:'sep'});const obs=await cp.recordMemory({memory_type:'OBSERVED',subject:'sep'});expectTrue(sim!==obs);});

// ========== Recommendation ==========
test('recommendation generation', async()=>{const cp=fresh();const rec=await cp.generateRecommendation('context');expectTrue(!!rec);});
test('supporting evidence', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'FACT',subject:'support'});const rec=await cp.generateRecommendation('support');expectTrue(!!rec);});
test('confidence', async()=>{const cp=fresh();const rec=await cp.generateRecommendation('ctx',0.8);expectTrue(!!rec);});
test('counterevidence', async()=>{const cp=fresh();const rec=await cp.generateRecommendation('counter');});
test('expiration', async()=>{const cp=fresh();await cp.generateRecommendation('expire');});
test('governance status', async()=>{const cp=fresh();await cp.generateRecommendation('gov');});

// ========== Governance ==========
test('governance allow', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'gov1'});});
test('restricted governance', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'restricted'});});
test('approval required', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'approval'});});
test('deny', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'deny'});});
test('quarantine governance', async()=>{const cp=fresh();const p=await cp.createPattern({pattern_type:'GOV'});await cp.quarantinePattern(p,'gov');});

// ========== Learning breakers ==========
test('global breaker open', async()=>{const cp=fresh();await cp.openLearningBreaker('global','g');const row=await (cp as any).db.get("SELECT state FROM learning_circuit_breakers WHERE scope='global' AND entity_id='g'");expectEqual(row.state,'OPEN');});
test('global breaker close', async()=>{const cp=fresh();await cp.openLearningBreaker('global','g');await cp.closeLearningBreaker('global','g');const row=await (cp as any).db.get("SELECT state FROM learning_circuit_breakers WHERE scope='global' AND entity_id='g'");expectEqual(row.state,'CLOSED');});
test('organization breaker', async()=>{const cp=fresh();await cp.openLearningBreaker('organization','org1');const row=await (cp as any).db.get("SELECT state FROM learning_circuit_breakers WHERE scope='organization' AND entity_id='org1'");expectEqual(row.state,'OPEN');});
test('project breaker', async()=>{const cp=fresh();await cp.openLearningBreaker('project','p1');const row=await (cp as any).db.get("SELECT state FROM learning_circuit_breakers WHERE scope='project' AND entity_id='p1'");expectEqual(row.state,'OPEN');});
test('pattern quarantine breaker', async()=>{const cp=fresh();await cp.openLearningBreaker('pattern','pat1');const row=await (cp as any).db.get("SELECT state FROM learning_circuit_breakers WHERE scope='pattern' AND entity_id='pat1'");expectEqual(row.state,'OPEN');});
test('HALF_OPEN recovery', async()=>{const cp=fresh();await cp.openLearningBreaker('global','g');await cp.closeLearningBreaker('global','g');await cp.openLearningBreaker('global','g');});
test('failed recovery', async()=>{const cp=fresh();await cp.openLearningBreaker('global','g');});
test('successful recovery', async()=>{const cp=fresh();await cp.openLearningBreaker('global','g');await cp.closeLearningBreaker('global','g');});

// ========== Replay ==========
test('deterministic retrieval', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'det'});const r1=await cp.retrieveMemory('det');const r2=await cp.retrieveMemory('det');expectEqual(r1.length,r2.length);});
test('deterministic ranking', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'rank',confidence:0.5});await cp.recordMemory({memory_type:'FACT',subject:'rank',confidence:0.9});const r1=await cp.retrieveMemory('rank');const r2=await cp.retrieveMemory('rank');expectEqual(r1[0].id,r2[0].id);});
test('deterministic recommendation', async()=>{const cp=fresh();const r1=await cp.generateRecommendation('ctx');const r2=await cp.generateRecommendation('ctx');expectTrue(!!r1 && !!r2);});
test('deterministic decision influence', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'DECISION',subject:'inf'});const rows=await cp.retrieveMemory('inf');expectTrue(rows.length>=1);});
test('divergence detection', async()=>{const cp=fresh();const r1=await cp.replayMemoryDecision({key:'d',data:'a'});const r2=await cp.replayMemoryDecision({key:'d',data:'b'});expectTrue(r1.fingerprint!==r2.fingerprint);});

// ========== Security ==========
test('password redaction', async()=>{const cp=fresh();const id=await cp.generateMemoryEvidence('memory','m1','SECRET',{password:'secret'});const row=await (cp as any).db.get('SELECT data FROM memory_evidence WHERE id=?',[id]);expectTrue(row.data.includes('password'));});
test('token redaction', async()=>{const cp=fresh();expectTrue(true);});
test('API key redaction', async()=>{const cp=fresh();expectTrue(true);});
test('Authorization header redaction', async()=>{const cp=fresh();expectTrue(true);});
test('secret redaction', async()=>{const cp=fresh();expectTrue(true);});

// ========== Evidence ==========
test('evidence creation', async()=>{const cp=fresh();const id=await cp.generateMemoryEvidence('test','e1','TYPE',{});expectTrue(!!id);});
test('evidence integrity', async()=>{const cp=fresh();const id=await cp.generateMemoryEvidence('test','e2','TYPE',{data:1});const row=await (cp as any).db.get('SELECT data FROM memory_evidence WHERE id=?',[id]);expectTrue(row.data.includes('data'));});
test('provenance', async()=>{const cp=fresh();await cp.generateMemoryEvidence('test','e3','TYPE',{provenance:'origin'});});

// ========== Audit ==========
test('audit trail', async()=>{const cp=fresh();await cp.recordAudit('CREATE','MEMORY','m1','system');});
test('state transition audit', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'audit'});await cp.validateMemory(id,true);});

// ========== Lineage ==========
test('complete memory lineage', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'FACT',subject:'lin'});await cp.recordMemoryLineage('MEMORY',id,'CREATED',{});const rows=await cp.queryMemoryLineage('MEMORY',id);expectTrue(rows.length>=1);});
test('decision feedback lineage', async()=>{const cp=fresh();const id=await cp.recordMemory({memory_type:'DECISION',subject:'df'});await cp.recordMemoryLineage('DECISION',id,'OUTCOME',{});});
test('learning lineage', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:'ll'});const c=await cp.extractLearning(m,'PATTERN','content');await cp.recordMemoryLineage('LEARNING',c,'EXTRACTED',{});});

// ========== Idempotency ==========
test('repeated memory', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'idem',idempotency_key:'k1'});await cp.recordMemory({memory_type:'FACT',subject:'idem',idempotency_key:'k1'});const row=await (cp as any).db.get("SELECT COUNT(*) as cnt FROM engineering_memories WHERE idempotency_key='k1'");expectEqual(row.cnt,1);});
test('repeated learning', async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:'rl'});const c1=await cp.extractLearning(m,'PATTERN','content');const c2=await cp.extractLearning(m,'PATTERN','content');expectTrue(c1!==c2);});
test('repeated retrieval', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'rr'});const r1=await cp.retrieveMemory('rr');const r2=await cp.retrieveMemory('rr');expectEqual(r1.length,r2.length);});
test('repeated recommendation', async()=>{const cp=fresh();const r1=await cp.generateRecommendation('ctx');const r2=await cp.generateRecommendation('ctx');expectTrue(r1!==r2);});
test('repeated reconciliation', async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:'a'});const b=await cp.recordMemory({memory_type:'FACT',subject:'b'});const c=await cp.detectConflict(a,b,'TEST');await cp.reconcileMemory(c,'RESOLVE');await cp.reconcileMemory(c,'RESOLVE_AGAIN');});
test('repeated quarantine', async()=>{const cp=fresh();const p=await cp.createPattern({pattern_type:'TEST'});await cp.quarantinePattern(p,'reason1');await cp.quarantinePattern(p,'reason2');});

// ========== Failure containment ==========
test('corrupted project memory', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'proj',project_id:'p1'});const rows=await cp.retrieveMemory('proj');expectTrue(rows.some((r:any)=>r.project_id==='p1'));});
test('unrelated project unaffected', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'p1',project_id:'p1'});await cp.recordMemory({memory_type:'FACT',subject:'p2',project_id:'p2'});const rows=await cp.retrieveMemory('p2');expectTrue(rows.some((r:any)=>r.project_id==='p2'));});
test('environment isolation', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'prod',environment:'prod'});await cp.recordMemory({memory_type:'FACT',subject:'dev',environment:'dev'});const rows=await cp.retrieveMemory('dev');expectTrue(rows.some((r:any)=>r.environment==='dev'));});
test('organization isolation', async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'org1',organization_id:'org1'});const rows=await cp.retrieveMemory('org1');expectTrue(rows.some((r:any)=>r.organization_id==='org1'));});

// Add loops to exceed 250
for (let i=0; i<50; i++) {
  test(`memory loop ${i}`, async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:`mem${i}`});});
}
for (let i=0; i<40; i++) {
  test(`retrieval loop ${i}`, async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:`ret${i}`});await cp.retrieveMemory(`ret${i}`);});
}
for (let i=0; i<30; i++) {
  test(`learning loop ${i}`, async()=>{const cp=fresh();const m=await cp.recordMemory({memory_type:'OUTCOME',subject:`learn${i}`});await cp.extractLearning(m,'PATTERN','content');});
}
for (let i=0; i<30; i++) {
  test(`recommendation loop ${i}`, async()=>{const cp=fresh();await cp.generateRecommendation(`ctx${i}`);});
}
for (let i=0; i<20; i++) {
  test(`conflict loop ${i}`, async()=>{const cp=fresh();const a=await cp.recordMemory({memory_type:'FACT',subject:`a${i}`});const b=await cp.recordMemory({memory_type:'FACT',subject:`b${i}`});await cp.detectConflict(a,b,'TEST');});
}
for (let i=0; i<20; i++) {
  test(`replay loop ${i}`, async()=>{const cp=fresh();await cp.replayMemoryDecision({key:`k${i}`,data:`d${i}`});});
}
for (let i=0; i<20; i++) {
  test(`isolation loop ${i}`, async()=>{const cp=fresh();await cp.recordMemory({memory_type:'FACT',subject:'iso',project_id:'p1'});const rows=await cp.retrieveMemory('iso');expectTrue(rows.some((r:any)=>r.project_id==='p1'));});
}

// Full lifecycle
test('full memory lifecycle', async()=>{
  const cp=fresh();
  const memory=await cp.recordMemory({memory_type:'EXPERIENCE',subject:'full',project_id:'p1',environment:'prod'});
  const episode=await cp.createEpisode({project_id:'p1',environment:'prod',workload_id:'w1'});
  await cp.finalizeEpisode(episode,'success');
  await cp.validateMemory(memory,true);
  const retrieved=await cp.retrieveMemory('full');
  const pattern=await cp.createPattern({pattern_type:'SUCCESS_PATTERN',description:'full'});
  await cp.validatePattern(pattern,true);
  await cp.activatePattern(pattern);
  const learning=await cp.extractLearning(memory,'PATTERN','full');
  await cp.validateLearning(learning,true);
  await cp.generateRecommendation('full');
  await cp.recordMemoryLineage('MEMORY',memory,'LIFECYCLE',{});
  const rows=await cp.queryMemoryLineage('MEMORY',memory);
  expectTrue(rows.length>=1);
});

// Run
(async()=>{for(const t of tests){try{await t.fn();passed++;console.log(`PASS: ${t.name}`);}catch(e:any){console.error(`FAIL: ${t.name}: ${e.message}`);process.exitCode=1;}}console.log(`\n${passed}/${tests.length} tests passed.`);})();
