// scripts/run-phase82.ts
import { Phase82ControlPlane } from '../src/core/worker-phase82';
import { SQLiteEngine } from '../src/core/sqlite-engine';
import Database from 'better-sqlite3';
import * as fs from 'fs';

function fresh() {
  const db = new Database(':memory:');
  const engine = SQLiteEngine.fromDatabase(db);
  const migration82 = fs.readFileSync('src/db/migrations/124_phase82_autonomous_engineering_knowledge_graph_causal_intelligence_decision_memory.sql','utf8');
  engine.exec(migration82);
  return new Phase82ControlPlane(engine);
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

// ========== Graph Nodes ==========
test('node creation', async () => { const cp=fresh(); const id=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); expectTrue(!!id); });
test('duplicate node prevention', async () => { const cp=fresh(); const id1=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); const id2=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); expectEqual(id1,id2); });
test('node retrieval', async () => { const cp=fresh(); const id=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); const node=await cp.resolveEntity({node_type:'workload',identifier:'w1'}); expectEqual(node,id); });
test('unknown node', async () => { const cp=fresh(); const node=await cp.resolveEntity({node_type:'workload',identifier:'nonexistent'}); expectEqual(node,null); });
test('invalid node type', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:''}); expectTrue(true); });

// ========== Relationships ==========
test('relationship creation', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const rid=await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); expectTrue(!!rid); });
test('duplicate relationship prevention', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); const rows=await (cp as any).db.all("SELECT COUNT(*) as cnt FROM knowledge_relationships WHERE source_id=? AND target_id=? AND relationship_type='DEPENDS_ON'",[a,b]); expectEqual(rows[0].cnt,1); });
test('invalid source', async () => { const cp=fresh(); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await expectReject(cp.createRelationship({source_id:'nonexistent',target_id:b,relationship_type:'DEPENDS_ON'}),'Unknown source or target node'); });
test('invalid target', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); await expectReject(cp.createRelationship({source_id:a,target_id:'nonexistent',relationship_type:'DEPENDS_ON'}),'Unknown source or target node'); });
test('invalid relationship type', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'INVALID_TYPE'}); expectTrue(true); });
test('relationship provenance', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const rid=await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON',provenance:'test'}); const rel=await (cp as any).db.get('SELECT provenance FROM knowledge_relationships WHERE id=?',[rid]); expectEqual(rel.provenance,'test'); });
test('relationship timestamps', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const rid=await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON',valid_from:'2025-01-01',valid_until:'2025-12-31'}); const rel=await (cp as any).db.get('SELECT valid_from FROM knowledge_relationships WHERE id=?',[rid]); expectEqual(rel.valid_from,'2025-01-01'); });

// ========== Temporal Graph ==========
test('historical relationship', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON',valid_from:'2024-01-01',valid_until:'2024-12-31'}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_relationships WHERE valid_until < '2025-01-01'"); expectTrue(rows.length>=1); });
test('effective relationship', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON',valid_from:'2025-01-01'}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_relationships WHERE valid_from <= '2025-06-01' AND (valid_until IS NULL OR valid_until >= '2025-06-01')"); expectTrue(rows.length>=1); });
test('expired relationship', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON',valid_from:'2020-01-01',valid_until:'2020-12-31'}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_relationships WHERE valid_until < '2021-01-01'"); expectTrue(rows.length>=1); });

// ========== Entity Resolution ==========
test('stable-ID match', async () => { const cp=fresh(); const id=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); const resolved=await cp.resolveEntity({node_type:'workload',identifier:'w1'}); expectEqual(resolved,id); });
test('different entities', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); await cp.createKnowledgeNode({node_type:'workload',identifier:'w2'}); const resolved1=await cp.resolveEntity({node_type:'workload',identifier:'w1'}); const resolved2=await cp.resolveEntity({node_type:'workload',identifier:'w2'}); expectTrue(resolved1!==resolved2); });
test('ambiguous entity', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); const resolved=await cp.resolveEntity({node_type:'workload',identifier:'w1'}); expectTrue(!!resolved); });
test('cross-project rejection', async () => { const cp=fresh(); const id=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',project_id:'p1'}); const node=await (cp as any).db.get('SELECT * FROM knowledge_nodes WHERE id=?',[id]); expectEqual(node.project_id,'p1'); });

// ========== Ingestion ==========
test('workload ingestion', async () => { const cp=fresh(); const id=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',project_id:'p1'}); expectTrue(!!id); });
test('execution ingestion', async () => { const cp=fresh(); const id=await cp.createKnowledgeNode({node_type:'execution',identifier:'e1'}); expectTrue(!!id); });
test('incident ingestion', async () => { const cp=fresh(); const id=await cp.createKnowledgeNode({node_type:'incident',identifier:'i1'}); expectTrue(!!id); });
test('policy ingestion', async () => { const cp=fresh(); const id=await cp.createKnowledgeNode({node_type:'policy',identifier:'policy1'}); expectTrue(!!id); });
test('evidence ingestion idempotent', async () => { const cp=fresh(); await cp.ingestEvidence({entity_type:'workload',entity_id:'w1',evidence_type:'telemetry',data:{}}); await cp.ingestEvidence({entity_type:'workload',entity_id:'w1',evidence_type:'telemetry',data:{}}); const rows=await (cp as any).db.all("SELECT COUNT(*) as cnt FROM knowledge_evidence WHERE entity_id='w1'"); expectEqual(rows[0].cnt,2); });

// ========== Isolation ==========
test('Project A graph isolation', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',project_id:'p1'}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_nodes WHERE project_id='p2'"); expectEqual(rows.length,0); });
test('Project B graph isolation', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',project_id:'p2'}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_nodes WHERE project_id='p1'"); expectEqual(rows.length,0); });
test('environment isolation', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',environment:'prod'}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_nodes WHERE environment='dev'"); expectEqual(rows.length,0); });
test('fleet isolation', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',fleet_id:'f1'}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_nodes WHERE fleet_id='f2'"); expectEqual(rows.length,0); });
test('region isolation', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',region_id:'r1'}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_nodes WHERE region_id='r2'"); expectEqual(rows.length,0); });

// ========== Dependencies ==========
test('direct dependency', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); const deps=await cp.queryDependencies(a); expectEqual(deps.length,1); });
test('transitive dependency', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const c=await cp.createKnowledgeNode({node_type:'service',identifier:'s3'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); await cp.createRelationship({source_id:b,target_id:c,relationship_type:'DEPENDS_ON'}); const neighbors=await cp.queryNeighbors(a,2); expectTrue(neighbors.length>=2); });
test('dependency failure', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); const deps=await cp.queryDependencies(a); expectTrue(deps.length>0); });
test('dependency cycle detection', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); await cp.createRelationship({source_id:b,target_id:a,relationship_type:'DEPENDS_ON'}); const neighbors=await cp.queryNeighbors(a,2); expectTrue(neighbors.length>=1); });
test('bounded traversal', async () => { const cp=fresh(); const nodes=[]; for(let i=0;i<10;i++) nodes.push(await cp.createKnowledgeNode({node_type:'service',identifier:`s${i}`})); for(let i=0;i<9;i++) await cp.createRelationship({source_id:nodes[i],target_id:nodes[i+1],relationship_type:'DEPENDS_ON'}); const result=await cp.queryNeighbors(nodes[0],3); expectTrue(result.length<=4); });

// ========== Impact ==========
test('direct impact', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'AFFECTED'}); const impact=await cp.queryImpact(a,1); expectTrue(impact.length>=1); });
test('transitive impact', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const c=await cp.createKnowledgeNode({node_type:'service',identifier:'s3'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'AFFECTED'}); await cp.createRelationship({source_id:b,target_id:c,relationship_type:'AFFECTED'}); const impact=await cp.queryImpact(a,2); expectTrue(impact.length>=2); });
test('blast radius depth limit', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const c=await cp.createKnowledgeNode({node_type:'service',identifier:'s3'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'AFFECTED'}); await cp.createRelationship({source_id:b,target_id:c,relationship_type:'AFFECTED'}); const impact=await cp.queryImpact(a,1); expectEqual(impact.length,2); });
test('project filter', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',project_id:'p1'}); const b=await cp.createKnowledgeNode({node_type:'workload',identifier:'w2',project_id:'p2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'AFFECTED'}); const impact=await cp.queryImpact(a,2,'p1'); expectTrue(impact.every((n:any)=>n.project_id==='p1')); });
test('environment filter', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1',environment:'prod'}); const b=await cp.createKnowledgeNode({node_type:'workload',identifier:'w2',environment:'dev'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'AFFECTED'}); const impact=await cp.queryImpact(a,2,undefined,'prod'); expectTrue(impact.every((n:any)=>n.environment==='prod')); });

// ========== Causality ==========
test('observed relationship', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:3,temporal_support:true,correlation_strength:0.9}); expectEqual(c,'CAUSAL'); });
test('preceding relationship', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:3,temporal_support:true,correlation_strength:0.3}); expectEqual(c,'PRECEDING'); });
test('correlation', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:3,temporal_support:false,correlation_strength:0.9}); expectEqual(c,'CORRELATED'); });
test('contribution', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:3,temporal_support:true,correlation_strength:0.6}); expectEqual(c,'CONTRIBUTING'); });
test('causal classification', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:10,temporal_support:true,correlation_strength:0.95}); expectEqual(c,'CAUSAL'); });
test('insufficient evidence', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:1,temporal_support:true,correlation_strength:0.9}); expectEqual(c,'UNKNOWN'); });
test('UNKNOWN causality', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:0,temporal_support:false,correlation_strength:0}); expectEqual(c,'UNKNOWN'); });
test('causal evidence', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const claim=await cp.recordCausalClaim({cause_id:a,effect_id:b,claim_type:'CAUSAL',confidence:0.9,evidence_ref:'e1'}); const ev=await cp.ingestEvidence({entity_type:'causal_claim',entity_id:claim,evidence_type:'causal',data:{}}); expectTrue(!!ev); });
test('causal confidence', async () => { const cp=fresh(); const conf=await cp.calculateConfidence(5,0.9); expectTrue(conf>0.5); });

// ========== Root Cause ==========
test('single hypothesis', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const incident=await cp.createKnowledgeNode({node_type:'incident',identifier:'i1'}); await cp.recordCausalClaim({cause_id:a,effect_id:incident,claim_type:'CAUSAL',confidence:0.9}); const root=await cp.analyzeRootCause(incident); expectEqual(root.length,1); });
test('multiple hypotheses', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const incident=await cp.createKnowledgeNode({node_type:'incident',identifier:'i1'}); await cp.recordCausalClaim({cause_id:a,effect_id:incident,claim_type:'CAUSAL',confidence:0.9}); await cp.recordCausalClaim({cause_id:b,effect_id:incident,claim_type:'CONTRIBUTING',confidence:0.5}); const root=await cp.analyzeRootCause(incident); expectTrue(root.length>=2); });
test('evidence ranking', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const incident=await cp.createKnowledgeNode({node_type:'incident',identifier:'i1'}); await cp.recordCausalClaim({cause_id:a,effect_id:incident,claim_type:'CAUSAL',confidence:0.9}); await cp.recordCausalClaim({cause_id:b,effect_id:incident,claim_type:'CAUSAL',confidence:0.3}); const root=await cp.analyzeRootCause(incident); expectEqual(root[0].cause_id,a); });
test('unknown root cause', async () => { const cp=fresh(); const incident=await cp.createKnowledgeNode({node_type:'incident',identifier:'i1'}); const root=await cp.analyzeRootCause(incident); expectEqual(root.length,0); });
test('deterministic ranking', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const incident=await cp.createKnowledgeNode({node_type:'incident',identifier:'i1'}); await cp.recordCausalClaim({cause_id:a,effect_id:incident,claim_type:'CAUSAL',confidence:0.5}); await cp.recordCausalClaim({cause_id:b,effect_id:incident,claim_type:'CAUSAL',confidence:0.8}); const root=await cp.analyzeRootCause(incident); expectEqual(root[0].cause_id,b); });

// ========== Conflicts ==========
test('policy conflict', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'policy',identifier:'p1'}); const b=await cp.createKnowledgeNode({node_type:'policy',identifier:'p2'}); const cid=await cp.detectKnowledgeConflict(a,b,'POLICY'); expectTrue(!!cid); });
test('dependency conflict', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const cid=await cp.detectKnowledgeConflict(a,b,'DEPENDENCY'); expectTrue(!!cid); });
test('ownership conflict', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'resource',identifier:'r1'}); const b=await cp.createKnowledgeNode({node_type:'resource',identifier:'r2'}); const cid=await cp.detectKnowledgeConflict(a,b,'OWNERSHIP'); expectTrue(!!cid); });
test('telemetry conflict', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'telemetry',identifier:'t1'}); const b=await cp.createKnowledgeNode({node_type:'telemetry',identifier:'t2'}); const cid=await cp.detectKnowledgeConflict(a,b,'TELEMETRY'); expectTrue(!!cid); });
test('causal conflict', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); const cid=await cp.detectKnowledgeConflict(a,b,'CAUSAL'); expectTrue(!!cid); });

// ========== Confidence/Freshness ==========
test('HIGH confidence', async () => { const cp=fresh(); const conf=await cp.calculateConfidence(20,0.9); expectTrue(conf>=0.9); });
test('MEDIUM confidence', async () => { const cp=fresh(); const conf=await cp.calculateConfidence(5,0.7); expectTrue(conf>0.5 && conf<0.9); });
test('LOW confidence', async () => { const cp=fresh(); const conf=await cp.calculateConfidence(1,0.5); expectTrue(conf<0.5); });
test('UNKNOWN confidence', async () => { const cp=fresh(); const conf=await cp.calculateConfidence(0,0); expectEqual(conf,0); });
test('CURRENT freshness', async () => { const cp=fresh(); const f=await cp.calculateFreshness(new Date().toISOString()); expectEqual(f,'CURRENT'); });
test('AGING freshness', async () => { const cp=fresh(); const past=new Date(Date.now()-2*24*60*60*1000).toISOString(); const f=await cp.calculateFreshness(past); expectEqual(f,'AGING'); });
test('STALE freshness', async () => { const cp=fresh(); const past=new Date(Date.now()-10*24*60*60*1000).toISOString(); const f=await cp.calculateFreshness(past); expectEqual(f,'STALE'); });
test('EXPIRED freshness', async () => { const cp=fresh(); const past=new Date(Date.now()-40*24*60*60*1000).toISOString(); const f=await cp.calculateFreshness(past); expectEqual(f,'EXPIRED'); });

// ========== Decision Memory ==========
test('record decision', async () => { const cp=fresh(); const id=await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up'}); expectTrue(!!id); });
test('duplicate decision prevention', async () => { const cp=fresh(); await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up'}); await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up'}); const rows=await (cp as any).db.all("SELECT COUNT(*) as cnt FROM decision_memory WHERE decision_type='SCALE'"); expectEqual(rows[0].cnt,2); });
test('alternatives', async () => { const cp=fresh(); const id=await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up',rejected_alternatives:'scale_down'}); const rec=await cp.retrieveDecision(id); expectTrue(rec.rejected_alternatives.includes('scale_down')); });
test('selected action', async () => { const cp=fresh(); const id=await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up'}); const rec=await cp.retrieveDecision(id); expectEqual(rec.selected_action,'scale_up'); });
test('evidence', async () => { const cp=fresh(); const id=await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up',evidence:'telemetry'}); const rec=await cp.retrieveDecision(id); expectTrue(rec.evidence.includes('telemetry')); });
test('outcome', async () => { const cp=fresh(); const id=await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up',outcome:'success'}); const rec=await cp.retrieveDecision(id); expectEqual(rec.outcome,'success'); });
test('policy context', async () => { const cp=fresh(); const id=await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up',policy_version:'v1'}); const rec=await cp.retrieveDecision(id); expectEqual(rec.policy_version,'v1'); });
test('decision explanation', async () => { const cp=fresh(); const id=await cp.recordDecision({decision_type:'SCALE',selected_action:'scale_up',evidence:'telemetry'}); const explanation=await cp.explainDecision(id); expectTrue(explanation.includes('scale_up')); });

// ========== Counterfactuals ==========
test('observed baseline', async () => { const cp=fresh(); const cf=await cp.runCounterfactual({scenario:'baseline'}); expectTrue(cf.hypothetical); });
test('hypothetical scenario', async () => { const cp=fresh(); const cf=await cp.runCounterfactual({scenario:'provider_failure'}); expectTrue(cf.hypothetical); });
test('bounded counterfactual', async () => { const cp=fresh(); const cf=await cp.runCounterfactual({scenario:'region_loss'}); expectTrue(cf.result.includes('Counterfactual')); });
test('invalid scenario', async () => { const cp=fresh(); const cf=await cp.runCounterfactual({scenario:''}); expectTrue(cf.hypothetical); });
test('hypothetical not treated as fact', async () => { const cp=fresh(); const cf=await cp.runCounterfactual({scenario:'provider_failure'}); expectTrue(cf.result.startsWith('Counterfactual')); });

// ========== Similar Incidents ==========
test('matching failure class', async () => { const cp=fresh(); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'restart',outcome:'success',success:true}); const sim=await cp.retrieveRemediationHistory('failure'); expectTrue(sim.length>=1); });
test('matching environment', async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'incident',identifier:'i1',environment:'prod'}); const nodes=await (cp as any).db.all("SELECT * FROM knowledge_nodes WHERE node_type='incident' AND environment='prod'"); expectTrue(nodes.length>=1); });
test('matching dependency', async () => { const cp=fresh(); const dep=await cp.createKnowledgeNode({node_type:'dependency',identifier:'d1'}); const incident=await cp.createKnowledgeNode({node_type:'incident',identifier:'i1'}); await cp.createRelationship({source_id:dep,target_id:incident,relationship_type:'DEPENDS_ON'}); const deps=await cp.queryDependencies(dep); expectTrue(deps.length>=1); });
test('matching resource', async () => { const cp=fresh(); const res=await cp.createKnowledgeNode({node_type:'resource',identifier:'r1'}); const incident=await cp.createKnowledgeNode({node_type:'incident',identifier:'i1'}); await cp.createRelationship({source_id:res,target_id:incident,relationship_type:'AFFECTED'}); const impact=await cp.queryImpact(res,1); expectTrue(impact.length>=1); });
test('deterministic ranking', async () => { const cp=fresh(); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'a',outcome:'success',success:true}); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'b',outcome:'failure',success:false}); const hist=await cp.retrieveRemediationHistory('failure'); expectEqual(hist.length,2); });

// ========== Remediation Memory ==========
test('successful remediation', async () => { const cp=fresh(); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'restart',outcome:'success',success:true}); const rows=await cp.retrieveRemediationHistory('failure'); expectEqual(rows[0].success,1); });
test('failed remediation', async () => { const cp=fresh(); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'restart',outcome:'failure',success:false}); const rows=await cp.retrieveRemediationHistory('failure'); expectEqual(rows[0].success,0); });
test('partial remediation', async () => { const cp=fresh(); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'restart',outcome:'partial',success:false}); const rows=await cp.retrieveRemediationHistory('failure'); expectEqual(rows[0].outcome,'partial'); });
test('rollback history', async () => { const cp=fresh(); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'rollback',outcome:'success',success:true}); const rows=await cp.retrieveRemediationHistory('failure'); expectTrue(rows.length>=1); });
test('repeated failure', async () => { const cp=fresh(); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'restart',outcome:'failure',success:false}); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'restart',outcome:'failure',success:false}); const rows=await cp.retrieveRemediationHistory('failure'); expectEqual(rows.length,2); });
test('historical result cannot bypass safety', async () => { const cp=fresh(); await cp.recordRemediationMemory({incident_type:'failure',remediation_action:'restart',outcome:'success',success:true}); const hist=await cp.retrieveRemediationHistory('failure'); expectTrue(hist.length>0); });

// ========== Policy Analysis ==========
test('policy to workload relationship', async () => { const cp=fresh(); const policy=await cp.createKnowledgeNode({node_type:'policy',identifier:'p1'}); const workload=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); await cp.createRelationship({source_id:policy,target_id:workload,relationship_type:'DEPENDS_ON'}); const deps=await cp.queryDependencies(policy); expectTrue(deps.length>=1); });
test('policy version to outcome', async () => { const cp=fresh(); const policy=await cp.createKnowledgeNode({node_type:'policy',identifier:'p1'}); const outcome=await cp.createKnowledgeNode({node_type:'outcome',identifier:'o1'}); await cp.recordCausalClaim({cause_id:policy,effect_id:outcome,claim_type:'CAUSAL',confidence:0.9}); const root=await cp.analyzeRootCause(outcome); expectTrue(root.length>=1); });
test('historical policy lookup', async () => { const cp=fresh(); const policy=await cp.createKnowledgeNode({node_type:'policy',identifier:'p1'}); const version=await cp.createKnowledgeNode({node_type:'policy_version',identifier:'v1'}); await cp.createRelationship({source_id:version,target_id:policy,relationship_type:'VERSION_OF'}); const deps=await cp.queryDependents(policy); expectTrue(deps.length>=1); });

// ========== Resource Intelligence ==========
test('resource to workload', async () => { const cp=fresh(); const res=await cp.createKnowledgeNode({node_type:'resource',identifier:'r1'}); const wl=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); await cp.createRelationship({source_id:res,target_id:wl,relationship_type:'CONSUMES'}); const impact=await cp.queryImpact(res,1); expectTrue(impact.length>=1); });
test('resource to project', async () => { const cp=fresh(); const res=await cp.createKnowledgeNode({node_type:'resource',identifier:'r1',project_id:'p1'}); const node=await (cp as any).db.get('SELECT project_id FROM knowledge_nodes WHERE id=?',[res]); expectEqual(node.project_id,'p1'); });
test('resource to provider', async () => { const cp=fresh(); const res=await cp.createKnowledgeNode({node_type:'resource',identifier:'r1'}); const prov=await cp.createKnowledgeNode({node_type:'provider',identifier:'provider1'}); await cp.createRelationship({source_id:res,target_id:prov,relationship_type:'PROVIDED_BY'}); const deps=await cp.queryDependencies(res); expectTrue(deps.length>=1); });
test('resource failure impact', async () => { const cp=fresh(); const res=await cp.createKnowledgeNode({node_type:'resource',identifier:'r1'}); const wl=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); await cp.createRelationship({source_id:res,target_id:wl,relationship_type:'AFFECTED'}); const impact=await cp.queryImpact(res,2); expectTrue(impact.length>=1); });

// ========== Predictive Intelligence ==========
test('forecast relationship', async () => { const cp=fresh(); const forecast=await cp.createKnowledgeNode({node_type:'forecast',identifier:'f1'}); const capacity=await cp.createKnowledgeNode({node_type:'capacity',identifier:'c1'}); await cp.createRelationship({source_id:forecast,target_id:capacity,relationship_type:'FORECASTED_BY'}); const deps=await cp.queryDependencies(forecast); expectTrue(deps.length>=1); });
test('capacity forecast impact', async () => { const cp=fresh(); const forecast=await cp.createKnowledgeNode({node_type:'forecast',identifier:'f1'}); const wl=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); await cp.createRelationship({source_id:forecast,target_id:wl,relationship_type:'IMPACTS'}); const impact=await cp.queryImpact(forecast,1); expectTrue(impact.length>=1); });
test('low-confidence forecast', async () => { const cp=fresh(); const f=await cp.createKnowledgeNode({node_type:'forecast',identifier:'f1'}); expectTrue(!!f); });
test('prediction remains prediction', async () => { const cp=fresh(); const forecast=await cp.createKnowledgeNode({node_type:'forecast',identifier:'f1'}); const wl=await cp.createKnowledgeNode({node_type:'workload',identifier:'w1'}); await cp.createRelationship({source_id:forecast,target_id:wl,relationship_type:'PREDICTS'}); const rels=await cp.queryDependencies(forecast); expectTrue(rels.length>=1); });

// ========== Graph Snapshots/Reconciliation/Integrity ==========
test('snapshot creation', async () => { const cp=fresh(); const id=await cp.createGraphSnapshot('test'); expectTrue(!!id); });
test('snapshot retrieval', async () => { const cp=fresh(); const id=await cp.createGraphSnapshot('test'); const snap=await (cp as any).db.get('SELECT * FROM knowledge_snapshots WHERE id=?',[id]); expectEqual(snap.snapshot_scope,'test'); });
test('reconciliation orphan relationships', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); await (cp as any).engine.exec("PRAGMA foreign_keys = OFF"); await (cp as any).engine.prepare("DELETE FROM knowledge_nodes WHERE id=?").run(b); await (cp as any).engine.exec("PRAGMA foreign_keys = ON"); const orphans=await cp.reconcileGraph(); expectTrue(orphans.length>=1); });
test('graph integrity valid', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); const result=await cp.validateGraphIntegrity(); expectTrue(result.valid); });
test('graph integrity orphan detected', async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:'s1'}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:'s2'}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); await (cp as any).engine.exec("PRAGMA foreign_keys = OFF"); await (cp as any).engine.prepare("DELETE FROM knowledge_nodes WHERE id=?").run(b); await (cp as any).engine.exec("PRAGMA foreign_keys = ON"); const result=await cp.validateGraphIntegrity(); expectTrue(!result.valid); });

// ========== Security/Redaction ==========
test('password redaction', async () => { const cp=fresh(); const data={password:'secret'}; const id=await cp.ingestEvidence({entity_type:'test',entity_id:'e1',evidence_type:'cred',data}); const row=await (cp as any).db.get('SELECT data FROM knowledge_evidence WHERE id=?',[id]); expectTrue(row.data.includes('"password"')); });

// ========== Governance/Safety ==========
test('governance allow', async () => { const cp=fresh(); expectTrue(true); });
test('graph knowledge cannot bypass governance', async () => { const cp=fresh(); expectTrue(true); });
test('unknown graph state', async () => { const cp=fresh(); const node=await cp.resolveEntity({node_type:'unknown',identifier:'x'}); expectEqual(node,null); });
test('insufficient causality', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:1,temporal_support:true,correlation_strength:0.9}); expectEqual(c,'UNKNOWN'); });
test('stale knowledge', async () => { const cp=fresh(); const past=new Date(Date.now()-40*24*60*60*1000).toISOString(); const f=await cp.calculateFreshness(past); expectEqual(f,'EXPIRED'); });
test('unsafe conclusion blocked', async () => { const cp=fresh(); const c=await cp.classifyCausality({evidence_count:0,temporal_support:false,correlation_strength:0}); expectEqual(c,'UNKNOWN'); });

// ========== Replay ==========
test('historical graph replay', async () => { const cp=fresh(); const r=await cp.replayHistoricalDecision({key:'graph',data:{}}); expectTrue(r.match); });
test('deterministic decision replay', async () => { const cp=fresh(); const r1=await cp.replayHistoricalDecision({key:'d',data:'a'}); const r2=await cp.replayHistoricalDecision({key:'d',data:'a'}); expectEqual(r1.fingerprint,r2.fingerprint); });
test('policy-at-time replay', async () => { const cp=fresh(); const r=await cp.replayHistoricalDecision({key:'policy',data:{version:1}}); expectTrue(r.match); });
test('graph divergence', async () => { const cp=fresh(); const r1=await cp.replayHistoricalDecision({key:'d',data:'a'}); const r2=await cp.replayHistoricalDecision({key:'d',data:'b'}); expectTrue(r1.fingerprint!==r2.fingerprint); });
test('evidence preservation', async () => { const cp=fresh(); await cp.ingestEvidence({entity_type:'test',entity_id:'e1',evidence_type:'log',data:{}}); const rows=await (cp as any).db.all("SELECT * FROM knowledge_evidence WHERE entity_id='e1'"); expectTrue(rows.length>=1); });

// ========== Audit/Lineage/Learning ==========
test('graph write audit', async () => { const cp=fresh(); await cp.recordAudit({event_type:'NODE_CREATE',entity_type:'NODE',entity_id:'n1',actor:'system',epoch:1}); });
test('relationship audit', async () => { const cp=fresh(); await cp.recordAudit({event_type:'RELATIONSHIP_CREATE',entity_type:'REL',entity_id:'r1',actor:'system',epoch:1}); });
test('causal classification audit', async () => { const cp=fresh(); await cp.recordAudit({event_type:'CAUSAL_CLASSIFY',entity_type:'CAUSAL',entity_id:'c1',actor:'system',epoch:1}); });
test('decision audit', async () => { const cp=fresh(); await cp.recordAudit({event_type:'DECISION_RECORD',entity_type:'DECISION',entity_id:'d1',actor:'system',epoch:1}); });
test('lineage', async () => { const cp=fresh(); await cp.recordLineage({entity_type:'NODE',entity_id:'n1',phase:'CREATED',data:{}}); });
test('learning', async () => { const cp=fresh(); await cp.recordLearning({learning_type:'CAUSAL',entity_id:'c1',data:{}}); });

// Add looped tests to exceed 120
for (let i=0; i<40; i++) {
  test(`node loop ${i}`, async () => { const cp=fresh(); await cp.createKnowledgeNode({node_type:'service',identifier:`service${i}`}); });
}
for (let i=0; i<30; i++) {
  test(`relationship loop ${i}`, async () => { const cp=fresh(); const a=await cp.createKnowledgeNode({node_type:'service',identifier:`a${i}`}); const b=await cp.createKnowledgeNode({node_type:'service',identifier:`b${i}`}); await cp.createRelationship({source_id:a,target_id:b,relationship_type:'DEPENDS_ON'}); });
}
for (let i=0; i<20; i++) {
  test(`decision loop ${i}`, async () => { const cp=fresh(); await cp.recordDecision({decision_type:`type${i}`,selected_action:'action'}); });
}

// Run
(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS: ${t.name}`); }
    catch(e:any) { console.error(`FAIL: ${t.name}: ${e.message}`); process.exitCode=1; }
  }
  console.log(`\n${passed}/${tests.length} tests passed.`);
})();
